import {randomBytes} from 'node:crypto';
import {Uint64} from '@ydbjs/value/primitive';

const PHONE=/^\d{10}$/;
const ATTEMPT=/^reg_[A-Za-z0-9_-]{12,125}$/;
const TTL=24*60*60*1000;
const numeric=n=>new Uint64(BigInt(n));
const normalized=v=>String(v||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('ru');
const name=v=>String(v||'').trim().replace(/\s+/g,' ').slice(0,160);
function validated(payload) {
  const phone10=String(payload?.phone||'').replace(/\D/g,'').slice(-10);
  const attemptId=String(payload?.attemptId||'');
  const parentName=name(payload?.parentName),childName=name(payload?.childName);
  if(!PHONE.test(phone10)||!ATTEMPT.test(attemptId)||!parentName||!childName){
    throw new Error('Invalid registration details.');
  }
  return {phone10,attemptId,parentName,childName};
}

// Registration requests are queued for in-person educator verification.
// No registration endpoint can self-assign a child's medical reports.
export function createParentRegistrationService({sql,sessions,now=()=>Date.now()}) {
  if(!sql?.begin||!sessions?.issueParent)throw new Error('Registration dependencies unavailable.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);

  async function register(payload) {
    const {phone10,attemptId,parentName,childName}=validated(payload);
    return write(async tx=>{
      const [deletions]=await tx`SELECT status FROM parent_deletion_queue WHERE phone10=${phone10}`;
      if(deletions.some(row=>['pending','retry','processing','failed'].includes(row.status))){
        return {ok:false,code:'DELETION_PENDING',message:'Профиль ещё удаляется. Попробуйте позже.'};
      }
      const [[existing]]=await tx`SELECT phone10 FROM parent_profiles WHERE phone10=${phone10}`;
      const [[attempt]]=await tx`SELECT phone10,parent_name,child_name,status,created_at
        FROM parent_registration_attempts WHERE attempt_id=${attemptId}`;
      if(attempt) {
        if(attempt.phone10!==phone10||normalized(attempt.parent_name)!==normalized(parentName)||
           normalized(attempt.child_name)!==normalized(childName)){
          throw new Error('Invalid registration attempt collision.');
        }
        return {ok:true,status:attempt.status||'PENDING'};
      }
      if(existing)return {ok:true,duplicate:true};
      const timestamp=now();
      await tx`UPSERT INTO parent_registration_attempts
        (attempt_id,phone10,parent_name,child_name,status,child_id,admission_id,
         approved_by,created_at,updated_at)
        VALUES (${attemptId},${phone10},${parentName},${childName},${'PENDING'},
          ${''},${''},${''},${numeric(timestamp)},${numeric(timestamp)})`;
      return {ok:true,status:'PENDING',registrationAttemptId:attemptId};
    });
  }
  async function status({phone,attemptId}) {
    const phone10=String(phone||'').replace(/\D/g,'').slice(-10);
    if(!PHONE.test(phone10)||!ATTEMPT.test(String(attemptId||'')))return {ok:true,status:'NOT_FOUND'};
    const row=await read(async tx=>{
      const [[a]]=await tx`SELECT attempt_id,phone10,parent_name,child_name,status,created_at,updated_at
        FROM parent_registration_attempts WHERE attempt_id=${String(attemptId)}`;
      return a&&a.phone10===phone10?a:null;
    });
    if(!row)return {ok:true,status:'NOT_FOUND'};
    if(row.status!=='COMPLETED')return {ok:true,status:row.status};
    if(now()-Number(row.updated_at||0)>TTL)return {ok:true,status:'EXPIRED'};
    const session=await sessions.issueParent(phone10);
    return {ok:true,status:'COMPLETED',phone:'8'+phone10,parentName:row.parent_name,
      childName:row.child_name,parentSession:session.token,
      d1Session:{ok:true,...session},registrationAttemptId:row.attempt_id};
  }
  async function listPending() {
    return read(async tx=>{
      const [rows]=await tx`SELECT attempt_id,phone10,parent_name,child_name,status,created_at
        FROM parent_registration_attempts WHERE status=${'PENDING'}`;
      return {ok:true,registrations:rows.map(r=>({attemptId:r.attempt_id,phone:'8'+r.phone10,
        parentName:r.parent_name,childName:r.child_name,createdAt:Number(r.created_at)}))};
    });
  }
  async function candidates() {
    return read(async tx=>{
      const [children]=await tx`SELECT child_id,registered_first_name,surname FROM children`;
      const [admissions]=await tx`SELECT admission_id,child_id,status FROM admissions`;
      const childrenMap=new Map(children.map(c=>[c.child_id,c]));
      return {ok:true,children:admissions.filter(a=>a.status==='active').map(a=>{
        const child=childrenMap.get(a.child_id);
        if(!child)throw new Error('Missing child for active admission.');
        return {childId:a.child_id,admissionId:a.admission_id,
          childName:[child.registered_first_name,child.surname].filter(Boolean).join(' ')};
      }).sort((a,b)=>a.childName.localeCompare(b.childName,'ru'))};
    });
  }
  async function decide({attemptId,decision,childId,admissionId,approvedBy='educator'}) {
    const id=String(attemptId||''),action=String(decision||'').toUpperCase();
    if(!ATTEMPT.test(id)||!['APPROVE','DENY'].includes(action))throw new Error('Invalid registration decision.');
    const handle=randomBytes(32).toString('base64url'),timestamp=now();
    return write(async tx=>{
      const [[attempt]]=await tx`SELECT phone10,parent_name,child_name,status
        FROM parent_registration_attempts WHERE attempt_id=${id}`;
      if(!attempt||attempt.status!=='PENDING')return {ok:false,code:'REQUEST_NOT_PENDING'};
      const [[already]]=await tx`SELECT phone10 FROM parent_profiles WHERE phone10=${attempt.phone10}`;
      if(already)return {ok:false,code:'PARENT_ALREADY_REGISTERED'};
      if(action==='DENY'){
        await tx`UPDATE parent_registration_attempts SET status=${'DENIED'},updated_at=${numeric(timestamp)}
          WHERE attempt_id=${id}`;
        return {ok:true,status:'DENIED'};
      }
      if(!childId||!admissionId)throw new Error('Invalid child or admission ID.');
      const [[child]]=await tx`SELECT child_id,registered_first_name,surname FROM children WHERE child_id=${String(childId)}`;
      const [[admission]]=await tx`SELECT admission_id,child_id,status FROM admissions
        WHERE admission_id=${String(admissionId)}`;
      if(!child||!admission||admission.status!=='active'||admission.child_id!==child.child_id){
        throw new Error('Invalid active admission for registration.');
      }
      const original=normalized(attempt.child_name);
      const registered=normalized([child.registered_first_name,child.surname].filter(Boolean).join(' '));
      const first=normalized(child.registered_first_name);
      if(original!==registered&&original!==first){
        throw new Error('Child name does not match active admission.');
      }
      await tx`UPSERT INTO parent_profiles
        (phone10,parent_name,relationship,child_id,admission_id,profile_generation,
         child_genitive,created_at,updated_at)
        VALUES (${attempt.phone10},${attempt.parent_name},${'Родитель'},
          ${String(childId)},${String(admissionId)},${id},${''},
          ${numeric(timestamp)},${numeric(timestamp)})`;
      await tx`UPSERT INTO parent_auth_profiles (phone10,user_handle,generation_id)
        VALUES (${attempt.phone10},${handle},${id})`;
      await tx`UPDATE parent_registration_attempts
        SET status=${'COMPLETED'},child_id=${String(childId)},admission_id=${String(admissionId)},
          approved_by=${String(approvedBy).slice(0,100)},updated_at=${numeric(timestamp)}
        WHERE attempt_id=${id}`;
      return {ok:true,status:'COMPLETED'};
    });
  }
  return {register,status,listPending,candidates,decide};
}
