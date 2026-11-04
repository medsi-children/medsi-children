import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {signCompatibleWorkerSession,verifyCompatibleWorkerSession,signCompatibleTutorSession,verifyCompatibleTutorSession,createSessionService} from '../app/session-auth.mjs';

const secret='s'.repeat(64);
const now=Date.now();
function legacyHmac(key,text){return createHmac('sha256',key).update(text).digest('base64url');}
test('worker tokens match the legacy Cloudflare wire-format and cannot be forged',()=>{
  const claims={role:'parent',phone10:'9000000001',exp:now+600000,authGeneration:'gen_1',version:'cf-parent-v2'};
  const token=signCompatibleWorkerSession(claims,secret);
  const [payload,mac]=token.split('.');
  assert.equal(mac,legacyHmac(secret,payload));
  assert.deepEqual(verifyCompatibleWorkerSession(token,secret,now),claims);
  assert.equal(verifyCompatibleWorkerSession(token,secret+'x',now),null);
  assert.equal(verifyCompatibleWorkerSession(token,secret,now+900000),null);
});
test('tutor1 tokens match Apps Script HMAC(login:password) and are revocable by version',()=>{
  const token=signCompatibleTutorSession('tutor','fake-test-password','version_a',now);
  const parts=token.split('.');
  assert.equal(parts[2],legacyHmac('tutor:fake-test-password',parts[1]));
  assert.equal(verifyCompatibleTutorSession(token,'tutor','fake-test-password','version_a'),true);
  assert.equal(verifyCompatibleTutorSession(token,'tutor','bad','version_a'),false);
  assert.equal(verifyCompatibleTutorSession(token,'tutor','fake-test-password','version_b'),false);
});
function fakeDb(generation='gen_1',createdAt=now-100000){
  return {async begin(_opts,fn){
    const tx=async(strings,...values)=>{
      const q=strings.join('?');
      if(q.includes('FROM parent_auth_profiles'))return [[{generation_id:generation,created_at:createdAt}]];
      if(q.includes('FROM parent_profiles'))return [[{phone10:values[0],admission_id:'admission_001'}]];
      throw Error('Unexpected SQL');
    };
    return fn(tx);
  }};
}
test('parent sessions survive cutover only with the same profile generation',async()=>{
  const service=createSessionService({sql:fakeDb(),secret,login:'tutor',password:'pw',tutorVersion:'v1',now:()=>now});
  const issued=await service.issueParent('9000000001');
  assert.equal((await service.verifyWorker(issued.token)).phone10,'9000000001');
  const different=createSessionService({sql:fakeDb('gen_CHANGED'),secret,login:'tutor',password:'pw',tutorVersion:'v1',now:()=>now});
  assert.equal(await different.verifyWorker(issued.token),null);
  const generationless=signCompatibleWorkerSession({role:'parent',phone10:'9000000001',exp:now+600000},secret);
  assert.equal(await service.verifyWorker(generationless),null);
  const wrong=service.loginTutor('tutor','no');
  assert.equal(wrong.ok,false);
  const logged=service.loginTutor('tutor','pw');
  assert.equal(logged.ok,true);
  assert.equal(service.verifyTutor(logged.token),true);
  assert.equal((await service.verifyWorker(logged.d1Session.token)).role,'educator');
});

test('existing parent D1 sessions remain valid after signing-key rotation when generation matches',async()=>{
  const oldSecret='l'.repeat(64);
  const service=createSessionService({sql:fakeDb(),secret,login:'new-tutor',
    password:'new-password',tutorVersion:'new-version',legacyWorkerSecret:oldSecret,
    now:()=>now});
  const original=signCompatibleWorkerSession({
    role:'parent',phone10:'9000000001',exp:now+86400000,
    authGeneration:'gen_1',version:'cf-parent-v2'
  },oldSecret);
  assert.equal((await service.verifyWorker(original)).phone10,'9000000001');
  const renewed=await service.issueParent('9000000001');
  assert.ok(verifyCompatibleWorkerSession(renewed.token,secret,now));
  assert.equal(verifyCompatibleWorkerSession(renewed.token,oldSecret,now),null);
  assert.equal(await createSessionService({sql:fakeDb(),secret,login:'new-tutor',
    password:'new-password',tutorVersion:'new-version',now:()=>now}).verifyWorker(original),null);
  const revoked=createSessionService({sql:fakeDb('recreated_profile'),secret,
    login:'new-tutor',password:'new-password',tutorVersion:'new-version',
    legacyWorkerSecret:oldSecret,now:()=>now});
  assert.equal(await revoked.verifyWorker(original),null);
});

test('pre-generation sessions require original pre-migration profile creation fence',async()=>{
  const oldSecret='l'.repeat(64);
  const oldClaims={role:'parent',phone10:'9000000001',
    exp:now+10*86400000,version:'cf-parent-v1'};
  const original=signCompatibleWorkerSession(oldClaims,oldSecret);
  const service=(createdAt)=>createSessionService({sql:fakeDb('gen_1',createdAt),
    secret,login:'tutor',password:'pw',tutorVersion:'new',
    legacyWorkerSecret:oldSecret,now:()=>now});
  assert.equal((await service(0).verifyWorker(original)).phone10,'9000000001');
  // IssuedAt is 30 days before expiry, so a newly registered/recreated
  // account may never inherit the older generationless token.
  assert.equal(await service(now-10*86400000).verifyWorker(original),null);
  assert.equal(await service(NaN).verifyWorker(original),null);
  const expired=signCompatibleWorkerSession({...oldClaims,exp:now-1},oldSecret);
  assert.equal(await service(0).verifyWorker(expired),null);
});

test('existing tutor1 sessions are recognized under old credentials without changing new logins',()=>{
  const old={login:'legacy-tutor',password:'legacy-test-password',version:'prior-version'};
  const s=createSessionService({sql:fakeDb(),secret,login:'new-tutor',
    password:'new-test-password',tutorVersion:'new-version',legacyTutor:old,now:()=>now});
  const oldToken=signCompatibleTutorSession(old.login,old.password,old.version,now-1000);
  assert.equal(s.verifyTutor(oldToken),true);
  assert.equal(s.renewTutor(oldToken).ok,true);
  assert.equal(s.loginTutor('new-tutor','new-test-password').ok,true);
  assert.equal(s.verifyTutor(signCompatibleTutorSession(old.login,old.password,'revoked-version',now)),false);
  const noLegacy=createSessionService({sql:fakeDb(),secret,login:'new-tutor',
    password:'new-test-password',tutorVersion:'new-version',now:()=>now});
  assert.equal(noLegacy.verifyTutor(oldToken),false);
});
