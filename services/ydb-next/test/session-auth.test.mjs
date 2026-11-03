import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {signCompatibleWorkerSession,verifyCompatibleWorkerSession,signCompatibleTutorSession,verifyCompatibleTutorSession,createSessionService} from '../src/session-auth.mjs';

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
function fakeDb(generation='gen_1'){
  return {async begin(_opts,fn){
    const tx=async(strings,...values)=>{
      const q=strings.join('?');
      if(q.includes('FROM parent_auth_profiles'))return [[{generation_id:generation,created_at:now-100000}]];
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
  const wrong=service.loginTutor('tutor','no');
  assert.equal(wrong.ok,false);
  const logged=service.loginTutor('tutor','pw');
  assert.equal(logged.ok,true);
  assert.equal(service.verifyTutor(logged.token),true);
  assert.equal((await service.verifyWorker(logged.d1Session.token)).role,'educator');
});
