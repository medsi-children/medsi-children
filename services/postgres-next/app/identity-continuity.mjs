
// Offline identity capture for migration under a frozen D1 write-fence.
// Inputs must come from an authorized encrypted export, never a public upload,
// GitHub Actions artifact, browser, or this chat.
const PHONE=/^\d{10}$/;
const HANDLE=/^[a-zA-Z0-9_-]{32,128}$/;
const CRED=/^[A-Za-z0-9_-]{16,1024}$/;
const B64=/^[a-zA-Z0-9_-]+$/;
const uint=n=>BigInt(n);
const natural=v=>Number.isSafeInteger(v)&&v>=0;
const validTime=v=>{
  const n=Number(v);
  if(!natural(n))throw new Error('Invalid identity timestamp.');
  return n;
};

export function prepareLegacyIdentityCapture({authProfiles,passkeys},
  {expectedProfiles,expectedPasskeys}={}) {
  if(!Array.isArray(authProfiles)||!Array.isArray(passkeys)||
     authProfiles.length>2000||passkeys.length>4000 ||
     authProfiles.length!==expectedProfiles||passkeys.length!==expectedPasskeys){
    throw new Error('Incomplete identity capture.');
  }
  const profiles=[],keys=[],byHandle=new Map(),byPhone=new Set(),byCredential=new Set();
  for(const row of authProfiles){
    const phone10=String(row.phone10||'');
    const userHandle=String(row.user_handle||'');
    const generationId=String(row.generation_id||'');
    if(!PHONE.test(phone10)||!HANDLE.test(userHandle)||
       !HANDLE.test(generationId)||byPhone.has(phone10)||byHandle.has(userHandle)) {
      throw new Error('Duplicate or invalid legacy auth identity.');
    }
    byPhone.add(phone10);byHandle.set(userHandle,phone10);
    profiles.push({phone10,userHandle,generationId,createdAt:validTime(row.created_at)});
  }
  for(const row of passkeys){
    const credentialId=String(row.credential_id||'');
    const userHandle=String(row.user_handle||'');
    const pub=String(row.public_key_base64url||'');
    if(!CRED.test(credentialId)||byCredential.has(credentialId)||
       !byHandle.has(userHandle)||!B64.test(pub)){
      throw new Error('Invalid or orphaned legacy passkey.');
    }
    let publicKey;
    try{publicKey=Buffer.from(pub,'base64url');}catch(_){throw new Error('Invalid passkey public key.');}
    if(publicKey.length<32||publicKey.length>2048||
       publicKey.toString('base64url')!==pub)throw new Error('Invalid passkey public key.');
    const counter=Number(row.counter);
    if(!natural(counter))throw new Error('Invalid passkey signature counter.');
    let transports;
    try{transports=typeof row.transports==='string'?JSON.parse(row.transports):row.transports;}
    catch(_){throw new Error('Invalid passkey transports.');}
    if(!Array.isArray(transports)||transports.length>8||
       transports.some(t=>!['ble','hybrid','internal','nfc','usb'].includes(t))){
      throw new Error('Invalid passkey transports.');
    }
    if(typeof row.backed_up!=='boolean'&&![0,1].includes(row.backed_up)) {
      throw new Error('Invalid passkey backup flag.');
    }
    const revokedAt=row.revoked_at==null?0:validTime(row.revoked_at);
    byCredential.add(credentialId);
    keys.push({credentialId,userHandle,publicKey:new Uint8Array(publicKey),
      counter,transportsJson:JSON.stringify(transports),
      deviceType:String(row.device_type||'').slice(0,60),
      backedUp:Boolean(row.backed_up),createdAt:validTime(row.created_at),
      revokedAt});
  }
  return {profiles,keys};
}

export async function importLegacyIdentityCapture(sql,capture,{
  expectedProfiles,expectedPasskeys,freezeConfirmed=false,explicitImport=false
}={}) {
  const prepared=prepareLegacyIdentityCapture(capture,{expectedProfiles,expectedPasskeys});
  if(!sql?.begin||!freezeConfirmed||!explicitImport) {
    throw new Error('Identity import requires frozen source and explicit approval.');
  }
  // Already imported or newly created sessions/passkeys may never be replaced.
  await sql.begin({isolation:'serializableReadWrite',idempotent:false},async tx=>{
    const [[authRows],[keyRows]] = await Promise.all([
      tx`SELECT phone10 FROM parent_auth_profiles LIMIT 1`,
      tx`SELECT credential_id FROM parent_passkeys LIMIT 1`
    ]);
    if(authRows?.length||keyRows?.length)throw new Error('Identity destination must be empty.');
    const [parents]=await tx`SELECT phone10 FROM parent_profiles`;
    const phones=new Set(parents.map(row=>String(row.phone10||'')));
    if(phones.size!==prepared.profiles.length||
       prepared.profiles.some(row=>!phones.has(row.phone10))) {
      throw new Error('Identity profiles do not match imported parents.');
    }
    for(const p of prepared.profiles) {
      await tx.upsert`INSERT INTO parent_auth_profiles
        (phone10,user_handle,generation_id,created_at)
        VALUES (${p.phone10},${p.userHandle},${p.generationId},${uint(p.createdAt)})`;
    }
    for(const k of prepared.keys) {
      await tx.upsert`INSERT INTO parent_passkeys
        (credential_id,user_handle,public_key,counter,transports_json,device_type,
         backed_up,created_at,revoked_at)
        VALUES (${k.credentialId},${k.userHandle},${k.publicKey},
          ${uint(k.counter)},${k.transportsJson},${k.deviceType},${k.backedUp},
          ${uint(k.createdAt)},${uint(k.revokedAt)})`;
    }
  });
  return {authProfiles:prepared.profiles.length,passkeys:prepared.keys.length};
}
