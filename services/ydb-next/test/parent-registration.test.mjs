import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentRegistrationService} from '../src/parent-registration.mjs';

const phone='9991112233';
function fakeDatabase({active=true}={}) {
  let attempt=null,profile=null,auth=null;
  const sql={begin:async(_,fn)=>fn(async(strings,...values)=>{
    const query=strings.join('?').replace(/\\s+/g,' ').trim();
    if(query.startsWith('SELECT')&&query.includes('FROM parent_profiles'))return [profile?[profile]:[]];
    if(query.startsWith('SELECT')&&query.includes('FROM parent_registration_attempts'))return [attempt?[attempt]:[]];
    if(query.startsWith('SELECT')&&query.includes('FROM children'))return [[{child_id:'child-1',registered_first_name:'Лена',surname:'Тестовая'}]];
    if(query.startsWith('SELECT')&&query.includes('FROM admissions'))return [[{admission_id:'adm-1',child_id:'child-1',status:active?'active':'discharged'}]];
    if(query.startsWith('UPSERT INTO parent_registration_attempts')) {
      attempt={attempt_id:values[0],phone10:values[1],parent_name:values[2],
        child_name:values[3],status:values[4],created_at:1000,updated_at:1000};
      return [];
    }
    if(query.startsWith('UPSERT INTO parent_profiles')) {
      profile={phone10:values[0],parent_name:values[1],child_id:values[3],
        admission_id:values[4]};return [];
    }
    if(query.startsWith('UPSERT INTO parent_auth_profiles')) {
      auth={phone10:values[0],user_handle:values[1],generation_id:values[2]};return [];
    }
    if(query.startsWith('UPDATE parent_registration_attempts')){
      if(query.includes('SET status=?'))attempt.status=values[0];
      if(query.includes('child_id=?')){attempt.child_id=values[1];attempt.admission_id=values[2];}
      attempt.updated_at=1000;return [];
    }
    throw new Error('Unexpected test SQL: '+query);
  })};
  return {sql,state:()=>({attempt,profile,auth})};
}
test('registration cannot self-approve or access child before staff decides',async()=>{
  const fake=fakeDatabase();let issued=0;
  const reg=createParentRegistrationService({sql:fake.sql,now:()=>2000,
    sessions:{issueParent:async()=>{issued++;return {token:'signed',expiresAt:1000000}}}});
  const payload={phone:'8'+phone,parentName:'Мария Тестовая',childName:'Лена Тестовая',
    attemptId:'reg_123456789012345678901234'};
  assert.equal((await reg.register(payload)).status,'PENDING');
  assert.equal((await reg.status({phone:payload.phone,attemptId:payload.attemptId})).status,'PENDING');
  assert.equal(fake.state().profile,null);
  assert.equal(issued,0);
  assert.equal((await reg.decide({attemptId:payload.attemptId,decision:'APPROVE',
    childId:'child-1',admissionId:'adm-1'})).status,'COMPLETED');
  assert.equal(fake.state().profile.phone10,phone);
  assert.ok(fake.state().auth.user_handle);
  assert.equal((await reg.status({phone:payload.phone,attemptId:payload.attemptId})).parentSession,'signed');
  assert.equal(issued,1);
});
test('registration refuses discharged or mismatched admissions',async()=>{
  const fake=fakeDatabase({active:false});
  const reg=createParentRegistrationService({sql:fake.sql,now:()=>2000,
    sessions:{issueParent:async()=>({token:'x'})}});
  const payload={phone:'8'+phone,parentName:'Мария Тестовая',childName:'Лена Тестовая',
    attemptId:'reg_123456789012345678901234'};
  await reg.register(payload);
  await assert.rejects(()=>reg.decide({attemptId:payload.attemptId,
    decision:'APPROVE',childId:'child-1',admissionId:'adm-1'}),/Invalid active admission/);
  assert.equal(fake.state().profile,null);
});
