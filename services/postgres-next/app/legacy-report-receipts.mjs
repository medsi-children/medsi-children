const ID=/^[A-Za-z0-9_-]{8,128}$/;
const KINDS=new Set(['morning','evening','psychology']);
const FIELDS=['submission_id','report_type','report_text','status','attempts',
  'last_error','result_json','created_at','updated_at'];
export const LEGACY_REPORT_JOB='legacy_report_submission_receipt';
export const legacyReportJobId=id=>'legacy-report:'+id;
const invalid=()=>{throw new Error('Invalid or unfinished legacy report receipt.');};
function timestamp(value){
  if(!/^(0|[1-9][0-9]{0,15})$/.test(String(value))||!Number.isSafeInteger(Number(value)))invalid();
  return String(value);
}
export function readLegacyReportReceipt(payload){
  let row;
  try{row=typeof payload==='string'?JSON.parse(payload):payload;}catch(_){invalid();}
  if(!row||Object.keys(row).length!==FIELDS.length||FIELDS.some(key=>!Object.hasOwn(row,key))||
      !ID.test(row.submission_id)||!KINDS.has(row.report_type)||typeof row.last_error!=='string'||
      typeof row.report_text!=='string'||!row.report_text.trim()||row.report_text.length>240000||
      !['completed','failed'].includes(row.status)||typeof row.result_json!=='string')invalid();
  let result=null;
  if(row.result_json){
    try{result=JSON.parse(row.result_json);}catch(_){invalid();}
    if(!result||typeof result!=='object'||Array.isArray(result))invalid();
  }
  if(row.status==='completed'&&result?.ok!==true)invalid();
  timestamp(row.created_at);timestamp(row.updated_at);timestamp(row.attempts);
  return {row,result};
}

// Preserve the original queue row, including its original ID and source-only
// fields. Archived receipts are never executable jobs. Failed reports remain
// failed; importing them must not publish a historical report or enqueue push.
export function captureLegacyReportReceipts(rows){
  if(!Array.isArray(rows))invalid();
  const seen=new Set();
  return rows.map(row=>{
    readLegacyReportReceipt(row);
    if(seen.has(row.submission_id))invalid();seen.add(row.submission_id);
    return {job_id:legacyReportJobId(row.submission_id),job_type:LEGACY_REPORT_JOB,
      payload_json:JSON.stringify(row),status:'archived',attempts:'0',next_attempt_at:null,
      created_at:timestamp(row.created_at)};
  });
}

export async function findLegacyReportReceipt(tx,id){
  const [[job]]=await tx`SELECT payload_json,status,job_type FROM background_jobs
    WHERE job_id=${legacyReportJobId(id)}`;
  if(!job)return null;
  if(job.status!=='archived'||job.job_type!==LEGACY_REPORT_JOB)invalid();
  const receipt=readLegacyReportReceipt(job.payload_json);
  if(receipt.row.submission_id!==id)invalid();
  return receipt;
}
