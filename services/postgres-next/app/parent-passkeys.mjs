import {randomBytes} from 'node:crypto';
import {
  generateAuthenticationOptions,generateRegistrationOptions,
  verifyAuthenticationResponse,verifyRegistrationResponse
} from '@simplewebauthn/server';

const TIMEOUT_MS=5*60*1000;
const buf=bytes=>new Uint8Array(Buffer.from(bytes||[]));
const id=()=> 'pach_'+randomBytes(24).toString('base64url');
const kinds=new Set(['registration','authentication']);

export function createParentPasskeyService({sql,sessions,env=process.env,now=()=>Date.now()}) {
  if(!sql?.begin || !sessions?.issueParent)throw new Error('Passkey dependencies unavailable.');
  const rpID=String(env.PARENT_PASSKEY_RP_ID||'');
  const origin=String(env.PARENT_PASSKEY_ORIGIN||'');
  if(!rpID||!/^https:\/\//.test(origin))throw new Error('Missing passkey relying party settings.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);

  async function account(phone10) {
    return read(async tx=>{
      const [[profile]]=await tx`SELECT phone10 FROM parent_profiles WHERE phone10=${phone10}`;
      const [[auth]]=await tx`SELECT phone10,user_handle,generation_id
        FROM parent_auth_profiles WHERE phone10=${phone10}`;
      return profile&&auth?auth:null;
    });
  }
  async function storeChallenge({purpose,phone10='',userHandle='',generationId='',challenge}) {
    if(!kinds.has(purpose))throw new Error('Bad challenge purpose.');
    const challengeId=id(),start=now();
    await write(async tx=>tx.upsert`INSERT INTO parent_auth_challenges
      (challenge_id,challenge,purpose,phone10,user_handle,generation_id,
       created_at,expires_at,consumed_at)
      VALUES (${challengeId},${challenge},${purpose},${phone10},${userHandle},
        ${generationId},${BigInt(start)},${BigInt(start+TIMEOUT_MS)},
        ${0n})`);
    return {challengeId,expiresAt:start+TIMEOUT_MS};
  }
  async function challengeOf(challengeId,purpose) {
    if(!/^pach_[A-Za-z0-9_-]{20,80}$/.test(challengeId))throw new Error('Bad challenge ID.');
    return read(async tx=>{
      const [[row]]=await tx`SELECT challenge_id,challenge,purpose,phone10,user_handle,
         generation_id,expires_at,consumed_at FROM parent_auth_challenges
         WHERE challenge_id=${challengeId}`;
      if(!row||row.purpose!==purpose||Number(row.expires_at)<=now()||Number(row.consumed_at)>0) {
        throw new Error('Запрос подтверждения истёк. Попробуйте ещё раз.');
      }
      return row;
    });
  }
  async function consumeChallenge(tx,challenge) {
    const [[saved]]=await tx`SELECT consumed_at,expires_at FROM parent_auth_challenges
      WHERE challenge_id=${challenge.challenge_id}`;
    if(!saved||Number(saved.consumed_at)>0||Number(saved.expires_at)<=now()) {
      throw new Error('Ключевой запрос уже использован.');
    }
    await tx`UPDATE parent_auth_challenges
      SET consumed_at=${BigInt(now())}
      WHERE challenge_id=${challenge.challenge_id}`;
  }
  async function hasPasskey(phone10) {
    const auth=await account(phone10);
    if(!auth)return {ok:false,code:'PROFILE_INACTIVE'};
    return read(async tx=>{
      const [rows]=await tx`SELECT credential_id,revoked_at FROM parent_passkeys
        WHERE user_handle=${auth.user_handle}`;
      return {ok:true,hasPasskey:rows.some(row=>!Number(row.revoked_at||0))};
    });
  }
  async function registrationOptions(phone10) {
    const auth=await account(phone10);
    if(!auth)throw new Error('Профиль неактивен.');
    const existing=await read(async tx=>{
      const [rows]=await tx`SELECT credential_id,transports_json,revoked_at FROM parent_passkeys
        WHERE user_handle=${auth.user_handle}`;
      return rows.filter(row=>!Number(row.revoked_at||0));
    });
    const options=await generateRegistrationOptions({
      rpName:'Медси Бот',rpID,
      userID:buf(Buffer.from(auth.user_handle,'base64url')),
      userName:'parent-'+auth.user_handle.slice(0,12),userDisplayName:'Медси Бот',
      attestationType:'none',authenticatorSelection:{residentKey:'required',userVerification:'required'},
      excludeCredentials:existing.map(c=>({
        id:c.credential_id,transports:JSON.parse(c.transports_json||'[]')
      }))
    });
    return {ok:true,...await storeChallenge({
      purpose:'registration',phone10,userHandle:auth.user_handle,
      generationId:auth.generation_id,challenge:options.challenge
    }),options};
  }
  async function registrationVerify(phone10,{challengeId,credential}) {
    const challenge=await challengeOf(String(challengeId||''),'registration');
    if(challenge.phone10!==phone10)throw new Error('Чужой запрос регистрации ключа.');
    const verified=await verifyRegistrationResponse({
      response:credential,expectedChallenge:challenge.challenge,expectedOrigin:origin,
      expectedRPID:rpID,requireUserVerification:true
    });
    const info=verified.registrationInfo;
    if(!verified.verified||!info?.credential||!info.userVerified)throw new Error('Ключ не подтверждён.');
    const c=info.credential;
    if(!/^[A-Za-z0-9_-]{16,1024}$/.test(c.id))throw new Error('Invalid passkey identifier.');
    return write(async tx=>{
      await consumeChallenge(tx,challenge);
      const [[auth]]=await tx`SELECT user_handle,generation_id FROM parent_auth_profiles
        WHERE phone10=${phone10}`;
      if(!auth||auth.generation_id!==challenge.generation_id||
         auth.user_handle!==challenge.user_handle)throw new Error('Профиль изменился.');
      const [[existing]]=await tx`SELECT credential_id FROM parent_passkeys WHERE credential_id=${c.id}`;
      if(existing)throw new Error('Ключ уже зарегистрирован.');
      await tx.upsert`INSERT INTO parent_passkeys
        (credential_id,user_handle,public_key,counter,transports_json,device_type,
         backed_up,created_at,revoked_at)
        VALUES (${c.id},${auth.user_handle},${buf(c.publicKey)},
        ${BigInt(c.counter||0)},
        ${JSON.stringify(info.credential.transports||[])},
        ${String(info.credentialDeviceType||'')},${!!info.credentialBackedUp},
        ${BigInt(now())},${0n})`;
      return {ok:true,enabled:true};
    });
  }
  async function authenticationOptions() {
    const options=await generateAuthenticationOptions({rpID,userVerification:'required'});
    return {ok:true,...await storeChallenge({purpose:'authentication',challenge:options.challenge}),options};
  }
  async function authenticationVerify({challengeId,credential}) {
    const challenge=await challengeOf(String(challengeId||''),'authentication');
    const credentialId=String(credential?.id||'');
    if(!/^[A-Za-z0-9_-]{16,1024}$/.test(credentialId))throw new Error('Invalid passkey.');
    const accountRow=await read(async tx=>{
      const [[key]]=await tx`SELECT credential_id,user_handle,public_key,counter,transports_json,
        revoked_at FROM parent_passkeys WHERE credential_id=${credentialId}`;
      if(!key||Number(key.revoked_at)>0)return null;
      const [profiles]=await tx`SELECT phone10,user_handle,generation_id FROM parent_auth_profiles`;
      const profile=profiles.find(row=>row.user_handle===key.user_handle);
      if(!profile)return null;
      return {...key,profile};
    });
    if(!accountRow)throw new Error('Ключ недоступен. Войдите по номеру телефона.');
    const verified=await verifyAuthenticationResponse({
      response:credential,expectedChallenge:challenge.challenge,
      expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,
      credential:{id:accountRow.credential_id,publicKey:buf(accountRow.public_key),
        counter:Number(accountRow.counter||0),
        transports:JSON.parse(accountRow.transports_json||'[]')}
    });
    if(!verified.verified||!verified.authenticationInfo?.userVerified)throw new Error('Ключ не подтверждён.');
    await write(async tx=>{
      await consumeChallenge(tx,challenge);
      const [[latest]]=await tx`SELECT credential_id,user_handle,counter,revoked_at
        FROM parent_passkeys WHERE credential_id=${credentialId}`;
      const [[profile]]=await tx`SELECT generation_id FROM parent_auth_profiles
        WHERE phone10=${accountRow.profile.phone10}`;
      if(!latest||Number(latest.revoked_at)>0||!profile||
         profile.generation_id!==accountRow.profile.generation_id||
         latest.user_handle!==accountRow.user_handle)throw new Error('Ключ больше не активен.');
      const counter=Math.max(Number(latest.counter||0),Number(verified.authenticationInfo.newCounter||0));
      await tx`UPDATE parent_passkeys SET counter=${BigInt(counter)}
        WHERE credential_id=${credentialId}`;
    });
    const session=await sessions.issueParent(accountRow.profile.phone10);
    return {ok:true,status:'APPROVED',phone:'8'+accountRow.profile.phone10,
      parentSession:session.token,d1Session:{ok:true,...session}};
  }
  return {hasPasskey,registrationOptions,registrationVerify,authenticationOptions,authenticationVerify};
}
