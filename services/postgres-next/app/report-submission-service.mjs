import {planLegacyReport} from './report-engine.mjs';
import {createReportPublicationStore} from './report-publications.mjs';

export function createReportSubmissionService(sql) {
  if(!sql?.begin)throw new Error('PostgreSQL query client required.');
  const publisher=createReportPublicationStore(sql);
  async function planningSnapshot(kind){
    return sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>{
      const [parents]=await tx`SELECT phone10,parent_name,child_id,admission_id,relationship,profile_generation
        FROM parent_profiles`;
      const [admissions]=await tx`SELECT admission_id,child_id,status FROM admissions`;
      const [children]=await tx`SELECT child_id,registered_first_name,surname FROM children`;
      const [variants]=await tx`SELECT base_key,preferred_name,variants_json FROM name_variants`;
      const [ownership]=await tx`SELECT owner_key,record_json FROM report_ownership`;
      const [prior]=await tx`SELECT phone10,kind,text,admission_id FROM parent_current_reports`;
      const admissionMap=new Map(admissions.filter(a=>a.status==='active').map(a=>[a.admission_id,a]));
      const childMap=new Map(children.map(c=>[c.child_id,c]));
      const previousReports=new Map(prior.filter(r=>r.kind===kind)
        .map(r=>[r.phone10,r]));
      const profiles=parents.filter(p=>admissionMap.has(p.admission_id)).map(p=>{
        const admission=admissionMap.get(p.admission_id);
        if(admission.child_id!==p.child_id)throw new Error('Active admission-child mismatch.');
        const child=childMap.get(p.child_id);
        if(!child)throw new Error('Missing child record for active parent.');
        const old=previousReports.get(p.phone10);
        return {
          phone10:p.phone10,parentName:p.parent_name || '',
          childName:child.registered_first_name || '',surname:child.surname || '',
          relationship:p.relationship || 'Родитель',admissionId:p.admission_id,
          profileGeneration:p.profile_generation || '',
          morning:kind==='morning'&&old?.admission_id===p.admission_id?old.text:'',
          evening:kind==='evening'&&old?.admission_id===p.admission_id?old.text:''
        };
      });
      return {
        profiles,
        nameVariants:variants.map(v=>{
          let values;
          try { values=JSON.parse(v.variants_json||'[]'); } catch (_) { values=[]; }
          if(!Array.isArray(values))values=[];
          return {preferredName:v.preferred_name||'',variants:values.join(', ')};
        }),
        ownerRecords:Object.fromEntries(ownership.map(row=>[row.owner_key,row.record_json]))
      };
    });
  }
  async function submit({kind,rawText,submissionId,authorId,submittedAt=Date.now()}){
    if(!['morning','evening','psychology'].includes(kind))throw new Error('Unsupported report kind.');
    const snapshot=await planningSnapshot(kind);
    const plan=planLegacyReport({kind,rawText,...snapshot});
    // Full roster and ownership are rechecked by the serializable
    // publication transaction, so no stale snapshot can reach parents.
    const result=await publisher.publishPrepared({
      kind,rawText,normalizedText:plan.normalizedText,
      recipients:plan.recipients,ownerReads:plan.ownerReads,ownerWrites:plan.ownerWrites,
      submissionId,authorId,submittedAt
    });
    return {ok:true,...result,validation:plan.validation};
  }
  async function status(submissionId) {
    const id=String(submissionId||'');
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(id))throw new Error('Invalid submission identifier.');
    return sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>{
      const [[row]]=await tx`SELECT submission_id,kind,publication_id,revision
        FROM report_submissions WHERE submission_id=${id}`;
      return row
        ? {status:'completed',result:{ok:true,publicationId:row.publication_id,
            revision:Number(row.revision||0)}}
        : {status:'not_found'};
    });
  }
  return {submit,status,planningSnapshot};
}
