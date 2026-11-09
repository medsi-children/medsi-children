import {randomUUID,createHash} from 'node:crypto';
import {planCurrentReport,currentReportVersion} from './current-report-plan.mjs';
const ID=/^[A-Za-z0-9_-]{8,128}$/;
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');
const dateMoscow=value=>{
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
};
// Replacement writer. One serializable transaction owns source, matching,
// parent reports, immutable block ownership, idempotency and push events.
// NO admissions relation. Suitable for schema 002 expansion and later contract.
export function createCurrentReportPublisher(sql){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  async function publish({kind,rawText,submissionId,authorId,submittedAt=Date.now(),
    correctionOf}={}){
    if(!['morning','evening','psychology'].includes(kind)||!ID.test(String(submissionId||''))||
      !ID.test(String(authorId||''))||typeof rawText!=='string'||!rawText.trim()||
      rawText.length>240000||!Number.isSafeInteger(submittedAt)||
      submittedAt<=0||submittedAt>Date.now()+60000)throw new Error('Invalid report publication.');
    if(correctionOf&&!ID.test(String(correctionOf)))throw new Error('Invalid correction reference.');
    const payloadHash=sha(kind+'\u0000'+rawText);
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[priorSubmission]]=await tx`SELECT kind,payload_hash,publication_id,revision
        FROM report_submissions WHERE submission_id=${submissionId}`;
      if(priorSubmission){
        if(priorSubmission.kind!==kind||priorSubmission.payload_hash!==payloadHash)
          throw new Error('Submission ID collision.');
        return {ok:true,status:'duplicate',publicationId:priorSubmission.publication_id,
          revision:Number(priorSubmission.revision)};
      }
      const [[profiles],[children],[variants],[head]]=await Promise.all([
        tx`SELECT phone10,child_id FROM parent_profiles`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT publication_id,revision,submitted_at FROM report_publication_head WHERE kind=${kind}`
      ]);
      if(head?.submitted_at&&submittedAt<=Number(head.submitted_at))
        return {ok:true,status:'superseded'};
      let reportDate=dateMoscow(submittedAt),priorOwners=[];
      if(correctionOf){
        if(head?.publication_id!==correctionOf)throw new Error('Source has been replaced; reload.');
        const [[original]]=await tx`SELECT report_date FROM raw_reports WHERE publication_id=${correctionOf}`;
        if(!original?.report_date)throw new Error('Correction source unavailable.');
        reportDate=String(original.report_date);
        const [ownerRows]=await tx`SELECT owner_key,record_json FROM report_ownership
          WHERE owner_key LIKE ${'CURRENT_BLOCK_'+correctionOf+'_%'}`;
        priorOwners=ownerRows.map(row=>{
          const index=Number(String(row.owner_key).split('_').at(-1));
          if(!Number.isSafeInteger(index))return null;
          let value=null;try{value=JSON.parse(row.record_json)}catch{}
          return {index,value};
        }).filter(Boolean);
      }
      const plan=planCurrentReport({kind,rawText,profiles,children,
        nameVariants:variants,
        priorBlockOwners:correctionOf?Array.from({length:1000},(_,i)=>
          priorOwners.find(x=>x.index===i)?.value):[]});
      const publicationId=randomUUID(),revision=Number(head?.revision||0)+1;
      const time=BigInt(submittedAt),rev=BigInt(revision);
      await tx.upsert`INSERT INTO raw_reports
        (publication_id,kind,report_date,raw_text,normalized_text,author_id,submitted_at,revision)
        VALUES (${publicationId},${kind},${reportDate},${rawText},${plan.normalizedText},
          ${authorId},${time},${rev})`;
      let queued=0;
      for(const row of plan.recipients){
        const version=currentReportVersion({kind,childId:row.childId,
          text:row.text,publicationId});
        const [[prior]]=await tx`SELECT version,read_version,child_id
          FROM parent_current_reports WHERE phone10=${row.phone10} AND kind=${kind}`;
        const unchanged=prior?.version===version&&String(prior.child_id||'')===row.childId;
        await tx.upsert`INSERT INTO parent_current_reports
          (phone10,kind,child_id,publication_id,revision,text,version,read_version,updated_at)
          VALUES (${row.phone10},${kind},${row.childId},${publicationId},${rev},
            ${row.text},${version},${unchanged?String(prior.read_version||''):''},${time})`;
        await tx.upsert`INSERT INTO parent_report_history
          (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
          VALUES (${row.phone10},${kind},${reportDate},${row.childId},${publicationId},
            ${rev},${row.text},${time})`;
        if(!unchanged&&kind!=='psychology'&&!correctionOf){
          const eventId='report_'+sha(publicationId+':'+row.phone10);
          await tx.upsert`INSERT INTO push_outbox
            (event_id,role,phone10,notification_json,status,attempts,next_attempt_at,created_at)
            VALUES (${eventId},${'parent'},${row.phone10},
              ${JSON.stringify({title:'Медси Бот',body:kind==='morning'?'Опубликован утренний отчёт.':'Опубликован вечерний отчёт.',type:'report',kind})},
              ${'pending'},${0n},${time},${time})`;
          queued++;
        }
      }
      // No patient identity is created for an unregistered child. Block
      // ownership is scoped to this exact source publication (not a stay).
      for(const record of plan.owners){
        const key='CURRENT_BLOCK_'+publicationId+'_'+record.index;
        const value=JSON.stringify({childId:record.childId,
          pending:!!record.pending,blocked:!!record.blocked});
        await tx.upsert`INSERT INTO report_ownership
          (owner_key,record_json,updated_at) VALUES (${key},${value},${time})`;
      }
      await tx.upsert`INSERT INTO report_submissions
        (submission_id,kind,payload_hash,publication_id,submitted_at,revision)
        VALUES (${submissionId},${kind},${payloadHash},${publicationId},${time},${rev})`;
      await tx.upsert`INSERT INTO report_publication_head
        (kind,publication_id,revision,submitted_at)
        VALUES (${kind},${publicationId},${rev},${time})`;
      return {ok:true,status:'published',publicationId,revision,
        recipients:plan.recipients.length,notificationsQueued:queued,
        unresolvedBlocks:plan.unresolved.length};
    });
  }
  return {publish};
}
