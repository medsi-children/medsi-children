import {backfillRecentEducatorReports} from './source-report-backfill.mjs';
import {reconcileUnlinkedRegisteredParents} from './parent-admission-matching.mjs';
import {rawReportMentionsChild} from './source-report-backfill.mjs';
// Educator-only roster. Report ownership remains on immutable IDs and admission IDs.
const PHONE=/^\d{10}$/;
const ID=/^[A-Za-z0-9_-]{8,128}$/;
const name=value=>String(value||'').trim().normalize('NFC').replace(/\s+/g,' ');
const validName=(value,max=90)=>{const result=name(value);if(!result||result.length>max||/[<>\x00-\x1f]/.test(result))throw new Error('Invalid roster name.');return result};
const validId=value=>{const result=String(value||'');if(!ID.test(result))throw new Error('Invalid roster identifier.');return result};

export function assembleEducatorRoster({children=[],admissions=[],profiles=[],currentReports=[],registeredPhones=[],rawReports=[],nameVariants=[]}={}){
  if(![children,admissions,profiles,currentReports,registeredPhones,rawReports,nameVariants].every(Array.isArray))throw new Error('Incomplete roster snapshot.');
  if(children.length>500||admissions.length>2000||profiles.length>1000||currentReports.length>4000)throw new Error('Unexpected roster size.');
  const childrenById=new Map(children.map(row=>[String(row.child_id),row]));
  const registered=new Set(registeredPhones.map(row=>String(row.phone10||'')));
  const active=new Map();
  for(const admission of admissions){
    if(admission.status!=='active')continue;
    const childId=String(admission.child_id||''),admissionId=String(admission.admission_id||'');
    const child=childrenById.get(childId);
    if(!child)throw new Error('Active admission references missing child.');
    active.set(admissionId,{childId,admissionId,firstName:String(child.registered_first_name||''),
      surname:String(child.surname||''),parents:[],morning:false,evening:false});
  }
  const unmatched=[],review=[];
  for(const profile of profiles){
    const phone10=String(profile.phone10||'');
    if(!PHONE.test(phone10))continue;
    const admissionId=String(profile.admission_id||''),childId=String(profile.child_id||'');
    const parent={phone10,phone:'8'+phone10,parentName:String(profile.parent_name||''),
      relationship:String(profile.relationship||'Родитель'),childName:String(profile.child_name||''),
      registered:registered.has(phone10)};
    const linked=active.get(admissionId);
    if(linked&&linked.childId===childId){linked.parents.push(parent);}
    else if(!childId&&!admissionId){
      if(!parent.registered)continue;
      const assignable=[];
      for(const admission of active.values()){
        const child=childrenById.get(admission.childId);
        if(!child)continue;
        const admissionCount=[...active.values()].filter(item=>item.childId===admission.childId).length;
        if(admissionCount!==1)continue;
        const evidence=rawReports.find(report=>(report.kind==='morning'||report.kind==='evening')&&
          rawReportMentionsChild({rawText:report.normalized_text||report.raw_text,
            child,activeChildren:[...active.values()].map(item=>childrenById.get(item.childId)).filter(Boolean),nameVariants}));
        if(evidence)assignable.push({childId:admission.childId,admissionId:admission.admissionId,
          label:[admission.firstName,admission.surname].filter(Boolean).join(' ')+' · '+
            (evidence.kind==='morning'?'утро':'вечер')+' '+String(evidence.report_date||'')});
      }
      unmatched.push({...parent,linked:false,assignable});
    }else{
      review.push({...parent,linked:false,reason:'stale-admission'});
    }
  }
  for(const report of currentReports){
    const card=active.get(String(report.admission_id||''));
    if(!card||!card.parents.some(p=>p.phone10===report.phone10)||!String(report.text||'').trim()||String(report.text).trim()==='Пока ещё нет отчёта 🙏')continue;
    if(report.kind==='morning')card.morning=true;
    if(report.kind==='evening')card.evening=true;
  }
  const result=[...active.values()].map(card=>({...card,parents:card.parents.sort((a,b)=>a.parentName.localeCompare(b.parentName,'ru'))}))
    .sort((a,b)=>(a.surname+' '+a.firstName).localeCompare(b.surname+' '+b.firstName,'ru'));
  return {ok:true,children:result,unlinked:unmatched.sort((a,b)=>a.phone.localeCompare(b.phone)),
    review:review.sort((a,b)=>a.phone.localeCompare(b.phone)),
    counts:{activeChildren:result.length,activeParentProfiles:result.reduce((n,c)=>n+c.parents.length,0),unlinkedProfiles:unmatched.length,reviewProfiles:review.length}};
}

export function createEducatorRosterStore(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL query client required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  async function list(){
    // Heal older registrations when an unambiguous hospital roster record
    // exists, before showing either a linked or unlinked directory card.
    await reconcileUnlinkedRegisteredParents(sql,{now});
    await backfillRecentEducatorReports(sql,{now});
    return read(async tx=>{
      const results=await Promise.all([
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT admission_id,child_id,status FROM admissions`,
        tx`SELECT phone10,parent_name,relationship,child_name,child_id,admission_id FROM parent_profiles`,
        tx`SELECT phone10,admission_id,kind,text FROM parent_current_reports`,
        tx`SELECT phone10 FROM parent_auth_profiles`,
        tx`SELECT kind,raw_text,normalized_text,report_date FROM raw_reports WHERE kind IN (${'morning'},${'evening'}) AND report_date>=${new Date(now()-14*24*60*60*1000).toISOString().slice(0,10)} ORDER BY submitted_at DESC LIMIT 60`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`
      ]);
      const [children,admissions,profiles,currentReports,registeredPhones,rawReports,nameVariants]=results.map(x=>x[0]||[]);
      return assembleEducatorRoster({children,admissions,profiles,currentReports,registeredPhones,rawReports,nameVariants});
    });
  }
  async function update(payload){
    const kind=String(payload.kind||'');
    if(kind==='child'){
      const childId=validId(payload.childId),admissionId=validId(payload.admissionId);
      const firstName=validName(payload.firstName,70),surname=validName(payload.surname,100);
      return write(async tx=>{
        const [[admission]]=await tx`SELECT child_id,status FROM admissions WHERE admission_id=${admissionId}`;
        if(!admission||admission.status!=='active'||admission.child_id!==childId)throw new Error('Roster changed; reload before editing.');
        const [[child]]=await tx`SELECT registered_first_name,surname FROM children WHERE child_id=${childId} FOR UPDATE`;
        if(!child)throw new Error('Roster changed; reload before editing.');
        if(name(child.registered_first_name)!==name(payload.expectedFirstName)||
           name(child.surname)!==name(payload.expectedSurname))throw new Error('Roster changed; reload before editing.');
        await tx`UPDATE children SET registered_first_name=${firstName},surname=${surname} WHERE child_id=${childId}`;
        await tx`UPDATE parent_profiles SET child_name=${firstName+' '+surname},updated_at=${BigInt(now())}
          WHERE child_id=${childId} AND admission_id=${admissionId}`;
        // No report payload or ownership identity is altered: existing distribution remains intact.
        return {ok:true,childId,admissionId};
      });
    }
    if(kind==='parent'){
      const phone10=String(payload.phone10||'');
      if(!PHONE.test(phone10))throw new Error('Invalid parent phone.');
      const parentName=validName(payload.parentName,130),relationship=validName(payload.relationship,50);
      const admissionId=validId(payload.admissionId),childId=validId(payload.childId);
      return write(async tx=>{
        const [[profile]]=await tx`SELECT parent_name,relationship,child_id,admission_id
          FROM parent_profiles WHERE phone10=${phone10} FOR UPDATE`;
        const [[admission]]=await tx`SELECT child_id,status FROM admissions WHERE admission_id=${admissionId}`;
        if(!profile||!admission||admission.status!=='active'||profile.admission_id!==admissionId||
           profile.child_id!==childId||admission.child_id!==childId)throw new Error('Roster changed; reload before editing.');
        if(name(profile.parent_name)!==name(payload.expectedParentName)||
           name(profile.relationship||'Родитель')!==name(payload.expectedRelationship||'Родитель'))throw new Error('Roster changed; reload before editing.');
        await tx`UPDATE parent_profiles SET parent_name=${parentName},relationship=${relationship},
          updated_at=${BigInt(now())} WHERE phone10=${phone10}`;
        return {ok:true,phone10};
      });
    }
    if(kind==='assign'){
      const phone10=String(payload.phone10||'');
      if(!PHONE.test(phone10))throw new Error('Invalid parent phone.');
      const childId=validId(payload.childId),admissionId=validId(payload.admissionId);
      return write(async tx=>{
        const [[profile]]=await tx`SELECT child_id,admission_id,profile_generation,child_name FROM parent_profiles WHERE phone10=${phone10} FOR UPDATE`;
        const [[admission]]=await tx`SELECT child_id,status FROM admissions WHERE admission_id=${admissionId}`;
        if(!profile||String(profile.child_id||'').trim()||String(profile.admission_id||'').trim()||
           !admission||admission.status!=='active'||String(admission.child_id)!==childId)
          throw new Error('Parent roster changed; reload before assigning.');
        const [[children],[activeAdmissions],[rawReports],[nameVariants]]=await Promise.all([
          tx`SELECT child_id,registered_first_name,surname FROM children`,
          tx`SELECT admission_id,child_id,status FROM admissions`,
          tx`SELECT kind,raw_text,normalized_text,report_date FROM raw_reports WHERE kind IN (${'morning'},${'evening'}) AND report_date>=${new Date(now()-14*24*60*60*1000).toISOString().slice(0,10)} ORDER BY submitted_at DESC LIMIT 60`,
          tx`SELECT base_key,preferred_name,variants_json FROM name_variants`
        ]);
        const activeChildren=activeAdmissions.filter(a=>a.status==='active')
          .map(a=>children.find(c=>String(c.child_id)===String(a.child_id))).filter(Boolean);
        const child=children.find(c=>String(c.child_id)===childId);
        const admissionCount=activeAdmissions.filter(a=>a.status==='active'&&String(a.child_id)===childId).length;
        const evidence=admissionCount===1&&child&&rawReports.some(report=>(report.kind==='morning'||report.kind==='evening')&&
          rawReportMentionsChild({rawText:report.normalized_text||report.raw_text,child,activeChildren,nameVariants}));
        if(!evidence)throw new Error('Parent roster changed; reload before assigning.');
        const [rows]=await tx`UPDATE parent_profiles SET child_id=${childId},admission_id=${admissionId},updated_at=${BigInt(now())}
          WHERE phone10=${phone10} AND COALESCE(child_id,${''})=${''} AND COALESCE(admission_id,${''})=${''} RETURNING phone10`;
        if(!rows.length)throw new Error('Parent roster changed; reload before assigning.');
        if(profile.profile_generation)await tx`UPDATE parent_registration_attempts SET child_id=${childId},admission_id=${admissionId},updated_at=${BigInt(now())}
          WHERE attempt_id=${String(profile.profile_generation)} AND phone10=${phone10} AND status=${'COMPLETED'}`;
        return {ok:true,phone10,childId,admissionId};
      });
    }
    throw new Error('Invalid roster update kind.');
  }
  return {list,update};
}
