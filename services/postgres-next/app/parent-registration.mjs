import {randomBytes} from 'node:crypto';
import {findUniqueActiveAdmissionForParent,parseRegisteredChildName,linkedAdmissionsForMatching} from './parent-admission-matching.mjs';
import {createAdmissionFromStaffReport,recentStaffSource,staffSourceContradictsExistingChild} from './report-observed-admission.mjs';
import {reconcileUnlinkedRegisteredParents} from './parent-admission-matching.mjs';
import {backfillRecentEducatorReports} from './source-report-backfill.mjs';

const PHONE=/^\d{10}$/;
const ATTEMPT=/^reg_[A-Za-z0-9_-]{12,125}$/;
const numeric=n=>BigInt(n);
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
      const [linkedParents]=await tx`SELECT child_id,admission_id FROM parent_profiles`;
      const matchingAdmissions=linkedAdmissionsForMatching({admissions,profiles:linkedParents});
      const [nameVariants]=await tx`SELECT base_key,preferred_name,variants_json FROM name_variants`;
      // Nicknames are resolved through the existing canonical variants table.
      // A full surname must agree and the active admission must be unique.
      // Never infer a child's clinical identity from one raw report mention.
      const timestamp=now();
      let match=findUniqueActiveAdmissionForParent({
        childName,children,admissions:matchingAdmissions,nameVariants
      });
      let reports=null;
      const entered=parseRegisteredChildName(childName);
      const matchedChild=match&&children.find(row=>String(row.child_id)===match.childId);
      if(match&&(!entered?.surnamePrefix||!String(matchedChild?.surname||'').trim())){
        reports=await recentStaffSource(tx,timestamp);
        const child=children.find(row=>String(row.child_id)===match.childId);
        if(staffSourceContradictsExistingChild({
          childName:entered?.first,surname:child?.surname||entered?.surnamePrefix,nameVariants,reports
        }))match=null;
      }
      if(!match){
        // When a new child is documented only in an educator's source
        // report, create their hospital identity if the name is unique.
        if(!reports)reports=await recentStaffSource(tx,timestamp);
        match=await createAdmissionFromStaffReport(tx,{
          childName,children,admissions:matchingAdmissions,nameVariants,reports,now:timestamp
        });
      }
      const userHandle=randomBytes(32).toString('base64url');
      await tx.upsert`INSERT INTO parent_profiles
        (phone10,parent_name,child_name,relationship,child_id,admission_id,
        profile_generation,child_genitive,created_at,updated_at)
        VALUES (${phone10},${parentName},${childName},${'Родитель'},
          ${match?.childId||''},${match?.admissionId||''},${attemptId},
          ${''},${numeric(timestamp)},${numeric(timestamp)})`;
      await tx.upsert`INSERT INTO parent_auth_profiles (phone10,user_handle,generation_id,created_at)
        VALUES (${phone10},${userHandle},${attemptId},${numeric(timestamp)})`;
      await tx.upsert`INSERT INTO parent_registration_attempts
        (attempt_id,phone10,parent_name,child_name,status,child_id,admission_id,
        approved_by,created_at,updated_at)
        VALUES (${attemptId},${phone10},${parentName},${childName},${'COMPLETED'},
          ${match?.childId||''},${match?.admissionId||''},
          ${''},${numeric(timestamp)},${numeric(timestamp)})`;
      return {ok:true,completed:true};
    });
    if(!result.ok)return result;
    // Registration itself must reconcile an unlinked parent and recover
    // eligible recent source reports. Do not rely on the parent opening
    // the report screen or an educator refreshing the roster first.
    // A failed recovery must not invalidate a committed registration;
    // authenticated report reads will retry the same guarded repair.
    const recover=async()=>{
      try{await reconcileUnlinkedRegisteredParents(sql,{phone10,now})}catch(_){}
      try{await backfillRecentEducatorReports(sql,{phone10,now})}catch(_){}
    };
    if(result.duplicate){await recover();return result}
    const session=await sessions.issueParent(phone10);
    await recover();
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
