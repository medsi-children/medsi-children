import {randomBytes} from 'node:crypto';
import {createCurrentChildLinkStore} from './current-child-link-store.mjs';
import {createCurrentReportBackfill} from './current-report-backfill.mjs';
const PHONE=/^\d{10}$/;
const ATTEMPT=/^reg_[A-Za-z0-9_-]{12,125}$/;
const clean=v=>String(v||'').trim().replace(/\s+/gu,' ').slice(0,160);
const normalized=v=>clean(v).normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
function details(payload){
  const phone10=String(payload?.phone||'').replace(/\D/g,'').slice(-10);
  const attemptId=String(payload?.attemptId||'');
  const parentName=clean(payload?.parentName),childName=clean(payload?.childName);
  if(!PHONE.test(phone10)||!ATTEMPT.test(attemptId)||!parentName||!childName)
    throw new Error('Invalid registration details.');
  return {phone10,attemptId,parentName,childName};
}
export function createCurrentParentRegistrationService({sql,sessions,now=()=>Date.now()}={}){
  if(!sql?.begin||!sessions?.issueParent)throw Error('Registration dependencies unavailable.');
  const link=createCurrentChildLinkStore(sql,{now});
  const backfill=createCurrentReportBackfill(sql,{now});
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  async function recover(phone10){
    try{await link.reconcile({phone10})}catch(_){}
    try{await backfill.recover({phone10})}catch(_){}
  }
  async function register(payload){
    const {phone10,attemptId,parentName,childName}=details(payload);
    const result=await write(async tx=>{
      const [deletions]=await tx`SELECT status FROM parent_deletion_queue WHERE phone10=${phone10}`;
      if(deletions.some(row=>['pending','retry','processing','failed'].includes(row.status)))
        return {ok:false,code:'DELETION_PENDING',message:'Удаление профиля ещё завершается.'};
      const [[prior]]=await tx`SELECT attempt_id,phone10,parent_name,child_name,status
        FROM parent_registration_attempts WHERE attempt_id=${attemptId}`;
      const [[existing]]=await tx`SELECT phone10,profile_generation FROM parent_profiles
        WHERE phone10=${phone10}`;
      if(prior){
        if(prior.phone10!==phone10||normalized(prior.parent_name)!==normalized(parentName)||
          normalized(prior.child_name)!==normalized(childName))
          throw new Error('Registration attempt collision.');
        if(!existing||existing.profile_generation!==attemptId)
          return {ok:false,status:'REVOKED',code:'REVOKED'};
        return {ok:true,duplicate:true};
      }
      if(existing)return {ok:true,duplicate:true};
      const at=BigInt(now());
      const handle=randomBytes(32).toString('base64url');
      // Registration is independent of staff publication and creates no
      // clinical patient/admission record. Link is resolved automatically
      // after commit and on each subsequent current-report request.
      await tx.upsert`INSERT INTO parent_profiles
        (phone10,parent_name,child_name,relationship,child_id,
          profile_generation,child_genitive,created_at,updated_at)
        VALUES (${phone10},${parentName},${childName},${'Родитель'},${''},
          ${attemptId},${''},${at},${at})`;
      await tx.upsert`INSERT INTO parent_auth_profiles
        (phone10,user_handle,generation_id,created_at)
        VALUES (${phone10},${handle},${attemptId},${at})`;
      await tx.upsert`INSERT INTO parent_registration_attempts
        (attempt_id,phone10,parent_name,child_name,status,child_id,
          approved_by,created_at,updated_at)
        VALUES (${attemptId},${phone10},${parentName},${childName},${'COMPLETED'},
          ${''},${''},${at},${at})`;
      return {ok:true,duplicate:false};
    });
    if(!result.ok)return result;
    const session=await sessions.issueParent(phone10);
    await recover(phone10);
    return {ok:true,duplicate:result.duplicate,phone:'8'+phone10,parentName,childName,
      parentSession:session.token,d1Session:{ok:true,...session},
      registrationAttemptId:attemptId};
  }
  async function status({phone,attemptId}={}){
    const phone10=String(phone||'').replace(/\D/g,'').slice(-10);
    if(!PHONE.test(phone10)||!ATTEMPT.test(String(attemptId||'')))
      return {ok:true,status:'NOT_FOUND'};
    const record=await read(async tx=>{
      const [[attempt]]=await tx`SELECT attempt_id,phone10,parent_name,child_name,status
        FROM parent_registration_attempts WHERE attempt_id=${String(attemptId)}`;
      if(!attempt||attempt.phone10!==phone10)return null;
      const [[profile]]=await tx`SELECT phone10,profile_generation FROM parent_profiles
        WHERE phone10=${phone10}`;
      return {attempt,profile};
    });
    if(!record)return {ok:true,status:'NOT_FOUND'};
    if(!record.profile||record.profile.profile_generation!==attemptId)
      return {ok:true,status:'REVOKED'};
    const session=await sessions.issueParent(phone10);
    await recover(phone10);
    return {ok:true,status:'COMPLETED',phone:'8'+phone10,
      parentName:record.attempt.parent_name,childName:record.attempt.child_name,
      parentSession:session.token,d1Session:{ok:true,...session},
      registrationAttemptId:attemptId};
  }
  return {register,status};
}
