import {createHmac} from 'node:crypto';
import {SCHEMA_SQL} from './schema-contract.mjs';
import {captureLegacyReportReceipts} from '../app/legacy-report-receipts.mjs';
const TYPES=new Map([...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/g)]
  .map(match=>[match[1],[...match[2].matchAll(/^\s*([a-z_][a-z_0-9]*)\s+(TEXT|BIGINT|BOOLEAN|BYTEA)\b/gm)]
    .map(col=>({name:col[1],type:col[2]}))]));
const ARCHIVE=['report_inactivity_state','report_push_dedup','report_state_import_runs','report_publication_state'];
const TABLES=['parent_auth_challenges','parent_deletion_queue','parent_registration_attempts',
  'parent_access_requests','parent_registration_outbox','report_submission_queue',...ARCHIVE];
const invalid=()=>{throw new Error('Operational capture is incomplete or contains unresolved work.');};
const scalar=value=>value===null||typeof value==='string'||typeof value==='boolean'||
  (typeof value==='number'&&Number.isFinite(value));

// Convert actual D1 queue states, not stale Apps Script mirror queues. Pending
// legacy deletions/registrations cannot be blindly replayed in the new system.
// Receipts, discarded workflow fields and housekeeping state remain private
// archived records, never runnable jobs. No historical push is created.
export function prepareD1OperationalCapture(tables,hmacKey){
  if(!tables||TABLES.some(name=>!Array.isArray(tables[name]))||
     typeof hmacKey!=='string'||Buffer.byteLength(hmacKey)<32)invalid();
  if(tables.parent_registration_outbox.length)invalid();
  const jobs=[],seenJobs=new Set();
  function archive(table,record){
    const payload=JSON.stringify({sourceTable:table,record});
    const id='legacy-state:'+createHmac('sha256',hmacKey).update(payload).digest('hex');
    if(seenJobs.has(id))invalid();seenJobs.add(id);
    jobs.push({job_id:id,job_type:'legacy_state_archive',payload_json:payload,status:'archived',
      attempts:'0',next_attempt_at:null,created_at:null});
  }
  function project(table,idField,allowedStatuses){
    const fields=TYPES.get(table),ids=new Set();
    return tables[table].map(row=>{
      if(!row||typeof row[idField]!=='string'||!row[idField]||ids.has(row[idField])||
         Object.values(row).some(value=>!scalar(value))||
         (allowedStatuses&&!allowedStatuses.includes(row.status)))invalid();
      ids.add(row[idField]);
      const result={};
      for(const {name,type} of fields){
        const value=Object.hasOwn(row,name)?row[name]:null;
        if(value===null){result[name]=null;continue;}
        if(type==='TEXT'){
          if(typeof value!=='string'||value.includes('\0'))invalid();
          result[name]=value;
        }else if(type==='BIGINT'){
          if(!/^(0|[1-9][0-9]{0,15})$/.test(String(value))||!Number.isSafeInteger(Number(value)))invalid();
          result[name]=String(value);
        }else invalid();
      }
      const extra=Object.fromEntries(Object.entries(row).filter(([name])=>!fields.some(field=>field.name===name)));
      if(Object.keys(extra).length)archive(table,{[idField]:row[idField],...extra});
      return result;
    });
  }
  const result={chat_sessions:[],push_outbox:[],
    parent_auth_challenges:project('parent_auth_challenges','challenge_id'),
    parent_deletion_queue:project('parent_deletion_queue','operation_id',['completed']),
    parent_registration_attempts:project('parent_registration_attempts','attempt_id',['COMPLETED']),
    parent_access_requests:project('parent_access_requests','request_id',['CONSUMED','DENIED','EXPIRED'])};
  for(const table of ARCHIVE)for(const row of tables[table]){
    if(!row||Object.values(row).some(value=>!scalar(value)))invalid();
    archive(table,row);
  }
  result.background_jobs=[...jobs,...captureLegacyReportReceipts(tables.report_submission_queue)];
  return result;
}
