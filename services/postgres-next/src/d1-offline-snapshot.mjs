import {DatabaseSync} from 'node:sqlite';
import {D1_CHAT_MESSAGES_QUERY,D1_CHAT_PINS_QUERY} from './d1-chat-capture.mjs';
import {D1_PARENT_PROFILES_QUERY} from './d1-profile-capture.mjs';
import {D1_CURRENT_REPORTS_QUERY,D1_REPORT_HISTORY_QUERY} from './d1-report-capture.mjs';

const queries=Object.freeze({
  messages:D1_CHAT_MESSAGES_QUERY,pins:D1_CHAT_PINS_QUERY,profiles:D1_PARENT_PROFILES_QUERY,
  currentReports:D1_CURRENT_REPORTS_QUERY,reportHistory:D1_REPORT_HISTORY_QUERY,
  publicationState:'SELECT kind,revision,source_fingerprint,publication_id,updated_at FROM report_publication_state',
  authProfiles:'SELECT phone10,user_handle,generation_id,created_at FROM parent_auth_profiles',
  passkeys:`SELECT credential_id,user_handle,public_key,counter,transports,device_type,
    backed_up,created_at,revoked_at FROM parent_passkeys`
});

const operationalTables=Object.freeze([
  'parent_auth_challenges','parent_deletion_queue','parent_registration_attempts',
  'parent_access_requests','parent_registration_outbox','report_submission_queue',
  'report_inactivity_state','report_push_dedup','report_state_import_runs'
]);

// Accept a SQLite snapshot prepared in the approved workspace. Do not log,
// persist or transmit the returned rows. No Cloudflare network call is made.
export function readOfflineD1Snapshot(path,{explicitRead,freezeConfirmed}={}){
  if(explicitRead!==true||freezeConfirmed!==true||typeof path!=='string'||!path.startsWith('/')){
    throw new Error('An explicitly approved frozen local D1 snapshot is required.');
  }
  let db;
  try{
    db=new DatabaseSync(path,{readOnly:true});
    db.exec('PRAGMA query_only=ON; BEGIN');
    const result=Object.fromEntries(Object.entries(queries).map(([name,sql])=>
      [name,db.prepare(sql).all().map(row=>({...row}))]));
    result.passkeys=result.passkeys.map(({public_key,...row})=>{
      if(!(public_key instanceof Uint8Array))throw new Error();
      return {...row,public_key_base64url:Buffer.from(public_key).toString('base64url')};
    });
    result.operationalCounts=Object.fromEntries(operationalTables.map(table=>
      [table,db.prepare('SELECT count(*) AS total FROM '+table).get().total]));
    db.exec('COMMIT');
    return result;
  }catch(_){
    throw new Error('Frozen D1 snapshot is unreadable or does not match the expected schema.');
  }finally{
    db?.close();
  }
}
