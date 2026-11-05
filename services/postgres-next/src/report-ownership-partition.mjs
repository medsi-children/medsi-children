import {createHmac} from 'node:crypto';

const invalid=()=>{throw new Error('Invalid report ownership capture.');};
const phone=value=>typeof value==='string'&&/^\d{10}$/.test(value);
const text=value=>typeof value==='string'&&!value.includes('\0');
const kinds=new Set(['morning','evening','psychology']);
const key=(phone10,admission,generation)=>JSON.stringify([phone10,admission,generation]);

// Preserve orphaned and stale source rows without attaching them to a new
// account that happens to reuse a phone. Quarantined jobs are storage only;
// no report-reader or scheduler reads or replays this job type.
export function partitionReportOwnership({current,history,profiles,historicalLinks=[]},hmacKey){
  if(![current,history,profiles,historicalLinks].every(Array.isArray)||
     typeof hmacKey!=='string'||Buffer.byteLength(hmacKey)<32)invalid();
  const active=new Map(),admissions=new Set(),generations=new Set();
  for(const profile of profiles){
    if(!phone(profile.phone10)||!text(profile.admission_id)||!text(profile.profile_generation)||
       active.has(profile.phone10))invalid();
    active.set(profile.phone10,profile);
  }
  for(const link of [...profiles,...historicalLinks]){
    if(!phone(link.phone10)||!text(link.admission_id)||!text(link.profile_generation))invalid();
    if(link.admission_id){
      admissions.add(key(link.phone10,link.admission_id,''));
      generations.add(key(link.phone10,link.admission_id,link.profile_generation));
    }
  }
  const jobs=[],seen=new Set();
  function partition(rows,table,historical){
    const accepted=[];
    for(const row of rows){
      if(!row||!phone(row.phone10)||!kinds.has(row.kind)||!text(row.child_admission_id)||
          !text(row.profile_generation)||!text(row.text)||
          Object.values(row).some(value=>value!==null&&(!['string','number','boolean'].includes(typeof value)||
            (typeof value==='number'&&!Number.isFinite(value)))))invalid();
      if(historical&&(!/^\d{4}-\d{2}-\d{2}$/.test(row.report_date)||
         !Number.isFinite(Date.parse(row.report_date+'T00:00:00Z'))||
         new Date(row.report_date+'T00:00:00Z').toISOString().slice(0,10)!==row.report_date))invalid();
      const identity=JSON.stringify([table,row.phone10,row.kind,historical?row.report_date:'']);
      if(seen.has(identity))invalid();seen.add(identity);
      const profile=active.get(row.phone10),admission=row.child_admission_id;
      const belongs=profile&&admission&&(historical
        ? row.profile_generation===''
          ? admissions.has(key(row.phone10,admission,''))
          : generations.has(key(row.phone10,admission,row.profile_generation))
        : profile.admission_id===admission&&
          (row.profile_generation===''||row.profile_generation===profile.profile_generation));
      if(belongs){accepted.push(row);continue;}
      const createdAt=historical?row.captured_at:row.updated_at;
      if(!/^(0|[1-9][0-9]{0,15})$/.test(String(createdAt))||!Number.isSafeInteger(Number(createdAt)))invalid();
      jobs.push({job_id:'legacy-report-quarantine:'+createHmac('sha256',hmacKey).update(identity).digest('hex'),
        job_type:'legacy_report_quarantine',payload_json:JSON.stringify({sourceTable:table,record:row}),
        status:'quarantined',attempts:'0',next_attempt_at:null,created_at:String(createdAt)});
    }
    return accepted;
  }
  const ownedCurrent=partition(current,'report_current',false);
  const ownedHistory=partition(history,'report_snapshots',true);
  return {current:ownedCurrent,history:ownedHistory,background_jobs:jobs};
}
