const PHONE=/^\d{10}$/;
const normalizePhone=v=>String(v||'').replace(/\D/g,'').slice(-10);

// Mirror the existing parent login contract: passkey users enter with
// their key, other active parents use the existing phone-based recovery.
// No educator approval, request queue or new staff screen.
export function createParentAccessService({sql,sessions}) {
  if(!sql?.begin||!sessions?.issueParent)throw new Error('Parent access dependencies unavailable.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);

  async function request(payload) {
    const phone10=normalizePhone(payload?.phone);
    if(!PHONE.test(phone10))throw new Error('Invalid recovery phone.');
    const result=await read(async tx=>{
      const [[profile]]=await tx`SELECT phone10,parent_name,child_name,child_id
        FROM parent_profiles WHERE phone10=${phone10}`;
      if(!profile)return null;
      const [[auth]]=await tx`SELECT user_handle FROM parent_auth_profiles WHERE phone10=${phone10}`;
      const [keys]=auth?.user_handle
        ?await tx`SELECT credential_id,revoked_at FROM parent_passkeys WHERE user_handle=${auth.user_handle}`
        :[[]];
      const activeKey=keys.some(item=>!item.revoked_at||Number(item.revoked_at)===0);
      if(activeKey)return {passkey:true};
      let childName=String(profile.child_name||'');
      if(!childName&&profile.child_id){
        const [[child]]=await tx`SELECT registered_first_name,surname FROM children WHERE child_id=${profile.child_id}`;
        if(child)childName=[child.registered_first_name,child.surname].filter(Boolean).join(' ');
      }
      return {profile,childName};
    });
    if(!result)return {ok:false,code:'NOT_FOUND',message:'Этот номер не найден среди активных родителей.'};
    if(result.passkey)return {ok:false,code:'PASSKEY_REQUIRED',
      message:'Для этого аккаунта сохранён ключ доступа. Войдите с его помощью.'};
    const session=await sessions.issueParent(phone10);
    return {ok:true,status:'APPROVED',recoveryMode:'phone-only',
      phone:'8'+phone10,parentName:result.profile.parent_name||'',
      childName:result.childName,parentSession:session.token,d1Session:{ok:true,...session}};
  }
  // The old parent app retries this endpoint after an ambiguous response.
  async function status(payload) {return request(payload);}
  async function listPending() {return {ok:true,requests:[]};}
  async function decide() {return {ok:false,code:'PARENT_APPROVAL_DISABLED',
    message:'Подтверждение входа воспитателем отключено.'};}
  return {request,status,listPending,decide};
}
