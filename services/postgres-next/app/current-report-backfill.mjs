import {planCurrentReport,currentReportVersion} from './current-report-plan.mjs';
import {currentStaffPublications} from './current-child-identity.mjs';
const PHONE=/^\d{10}$/;
const moscowDate=at=>{
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  const by=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return by.year+'-'+by.month+'-'+by.day;
};
// Recover only TODAY's latest staff source for a registered child.
// Previously published blocks are authorized by publication-scoped
// ownership; a deleted parent's old block is never reissued to a namesake.
export function createCurrentReportBackfill(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  async function recover({phone10=''}={}){
    if(phone10&&!PHONE.test(String(phone10)))throw new Error('Invalid phone.');
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[profiles],[children],[variants],[raw]]=await Promise.all([
        tx`SELECT phone10,child_id FROM parent_profiles`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT r.publication_id,r.kind,r.report_date,r.normalized_text,r.submitted_at
          FROM report_publication_head AS h
          INNER JOIN raw_reports AS r ON r.publication_id=h.publication_id
          WHERE r.kind IN (${'morning'},${'evening'})`
      ]);
      const sources=currentStaffPublications(raw,moscowDate(now()));
      let backfilled=0;
      for(const source of sources){
        const prefix='CURRENT_BLOCK_'+source.publication_id+'_';
        const [ownerRows]=await tx`SELECT owner_key,record_json FROM report_ownership
          WHERE owner_key LIKE ${prefix+'%'}`;
        const owners=[],saved=new Map();
        for(const row of ownerRows){
          const index=Number(String(row.owner_key).slice(prefix.length));
          if(!Number.isSafeInteger(index)||index<0)continue;
          let record;
          try{record=JSON.parse(String(row.record_json||''))}
          catch{record={blocked:true}}
          owners[index]=record;
          saved.set(index,{key:row.owner_key,raw:row.record_json,record});
        }
        const plan=planCurrentReport({kind:source.kind,rawText:source.normalized_text||'',
          profiles,children,nameVariants:variants,priorBlockOwners:owners});
        for(const recipient of plan.recipients){
          if(phone10&&recipient.phone10!==phone10)continue;
          const child=children.find(c=>String(c.child_id)===recipient.childId);
          if(!child)continue;
          const version=currentReportVersion({kind:source.kind,
            childId:recipient.childId,text:recipient.text,publicationId:source.publication_id});
          const [[current]]=await tx`SELECT child_id,publication_id,text
            FROM parent_current_reports WHERE phone10=${recipient.phone10}
              AND kind=${source.kind}`;
          if(current&&current.child_id===recipient.childId&&
            current.publication_id===source.publication_id&&current.text===recipient.text)continue;
          const at=BigInt(source.submitted_at||now());
          await tx.upsert`INSERT INTO parent_current_reports
            (phone10,kind,child_id,publication_id,revision,text,version,read_version,updated_at)
            VALUES (${recipient.phone10},${source.kind},${recipient.childId},
              ${source.publication_id},${1n},${recipient.text},${version},${''},${at})`;
          await tx.upsert`INSERT INTO parent_report_history
            (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
            VALUES (${recipient.phone10},${source.kind},${source.report_date},
              ${recipient.childId},${source.publication_id},${1n},${recipient.text},${at})`;
          backfilled++;
        }
        // A pending block becomes owned by the SAME registered child after
        // late enrollment, without republishing or mutating the raw source.
        for(const next of plan.owners){
          const prior=saved.get(next.index);
          if(!prior?.record?.pending||!next.childId)continue;
          const replacement=JSON.stringify({childId:next.childId,blocked:false,pending:false});
          await tx`UPDATE report_ownership SET record_json=${replacement},
            updated_at=${BigInt(now())} WHERE owner_key=${prior.key}
            AND record_json=${prior.raw}`;
        }
      }
      return {ok:true,backfilled};
    });
  }
  return {recover};
}
