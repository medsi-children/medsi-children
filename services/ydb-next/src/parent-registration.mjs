import {randomBytes} from 'node:crypto';
import {Uint64} from '@ydbjs/value/primitive';

const PHONE=/^\d{10}$/;
const ATTEMPT=/^reg_[A-Za-z0-9_-]{12,125}$/;
const numeric=n=>new Uint64(BigInt(n));
const clean=v=>String(v||'').trim().replace(/\s+/g,' ').slice(0,160);
const normalize=v=>clean(v).normalize('NFC').toLocaleLowerCase('ru').replace(/ё/g,'е');
function details(payload) {
  const phone10=String(payload?.phone||'').replace(/\D/g,'').slice(-10);
  const attemptId=String(payload?.attemptId||'');
  const parentName=clean(payload?.parentName),childName=clean(payload?.childName);
  if(!PHONE.test(phone10)||!ATTEMPT.test(attemptId)||!parentName||!childName){
    throw new Error('Invalid registration details.');
  }
  return {phone10,attemptId,parentName,childName};
}

export function createParentRegistrationService({sql,sessions,now=()=>Date.now()}) {
  if(!sql?.begin||!sessions?.issueParent)throw new Error('Registration dependencies unavailable.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);

  // Same as the active application: registration is completed by the parent,
  // without any educator approval, roster picker or extra UI.
  // Clinical reports are linked only if an existing roster entry is unique.
  async function register(payload) {
    const {phone10,attemptId,parentName,childName}=details(payload);
    const result=await write(async tx=>{
      const [deletions]=await tx`SELECT status FROM parent_deletion_queue WHERE phone10=${phone10}`;
      if(deletions.some(row=>['pending','retry','processing','failed'].includes(row.status))) {
        return {ok:false,code:'DELETION_PENDING',message:'Удаление профиля ещё завершается.'};
      }
      const [[prior]]=await tx`SELECT attempt_id,phone10,parent_name,child_name,status
        FROM parent_registration_attempts WHERE attempt_id=${attemptId}`;
      const [[existing]]=await tx`SELECT phone10,profile_generation
        FROM parent_profiles WHERE phone10=${phone10}`;
      if(prior) {
        if(prior.phone10!==phone10||normalize(prior.parent_name)!==normalize(parentName)||
          normalize(prior.child_name)!==normalize(childName)) {
          throw new Error('Invalid registration attempt collision.');
        }
        if(!existing||existing.profile_generation!==attemptId) {
          return {ok:false,status:'REVOKED',code:'REVOKED'};
        }
        return {ok:true,completed:true};
      }
      if(existing)return {ok:true,duplicate:true};
      const [children]=await tx`SELECT child_id,registered_first_name,surname FROM children`;
      const [admissions]=await tx`SELECT admission_id,child_id,status FROM admissions`;
      const byId=new Map(children.map(c=>[c.child_id,c]));
      const matches=admissions.filter(a=>a.status==='active').filter(a=>{
        const child=byId.get(a.child_id);
        if(!child)return false;
        const full=normalize([child.registered_first_name,child.surname].filter(Boolean).join(' '));
        // No fuzzy-name or first-name-only matching for confidential reports.
        return Boolean(full)&&full===normalize(childName);
      });
      const unique=matches.length===1?matches[0]:null;
      const timestamp=now(),userHandle=randomBytes(32).toString('base64url');
      await tx`UPSERT INTO parent_profiles
        (phone10,parent_name,child_name,relationship,child_id,admission_id,
        profile_generation,child_genitive,created_at,updated_at)
        VALUES (${phone10},${parentName},${childName},${'Родитель'},
          ${unique?.child_id||''},${unique?.admission_id||''},${attemptId},
          ${''},${numeric(timestamp)},${numeric(timestamp)})`;
      await tx`UPSERT INTO parent_auth_profiles (phone10,user_handle,generation_id)
        VALUES (${phone10},${userHandle},${attemptId})`;
      await tx`UPSERT INTO parent_registration_attempts
        (attempt_id,phone10,parent_name,child_name,status,child_id,admission_id,
        approved_by,created_at,updated_at)
        VALUES (${attemptId},${phone10},${parentName},${childName},${'COMPLETED'},
          ${unique?.child_id||''},${unique?.admission_id||''},
          ${''},${numeric(timestamp)},${numeric(timestamp)})`;
      return {ok:true,completed:true};
    });
    if(!result.ok||result.duplicate)return result;
    const session=await sessions.issueParent(phone10);
    return {ok:true,duplicate:false,phone:'8'+phone10,parentName,childName,
      parentSession:session.token,d1Session:{ok:true,...session},registrationAttemptId:attemptId};
  }

  async function status({phone,attemptId}) {
    const phone10=String(phone||'').replace(/\D/g,'').slice(-10);
    if(!PHONE.test(phone10)||!ATTEMPT.test(String(attemptId||'')))return {ok:true,status:'NOT_FOUND'};
    const record=await read(async tx=>{
      const [[attempt]]=await tx`SELECT attempt_id,phone10,parent_name,child_name,status
        FROM parent_registration_attempts WHERE attempt_id=${String(attemptId)}`;
      if(!attempt||attempt.phone10!==phone10)return null;
      const [[profile]]=await tx`SELECT phone10,profile_generation FROM parent_profiles WHERE phone10=${phone10}`;
      return {attempt,profile};
    });
    if(!record)return {ok:true,status:'NOT_FOUND'};
    if(!record.profile||record.profile.profile_generation!==String(attemptId)){
      return {ok:true,status:'REVOKED'};
    }
    const session=await sessions.issueParent(phone10);
    return {ok:true,status:'COMPLETED',phone:'8'+phone10,
      parentName:record.attempt.parent_name,childName:record.attempt.child_name,
      parentSession:session.token,d1Session:{ok:true,...session},registrationAttemptId:String(attemptId)};
  }
  return {register,status};
}
