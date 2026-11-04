import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentRegistrationService} from '../app/parent-registration.mjs';

const phone='9991112233';
const payload={phone:'8'+phone,parentName:'Мария Тестовая',childName:'Лена Тестовая',
  attemptId:'reg_123456789012345678901234'};
function fakeDatabase({matched=true}={}) {
  let attempt=null,profile=null,auth=null;
  const sql={begin:async(_opts,fn)=>{
   const tx=async(strings,...values)=>{
    const query=strings.join('?').replace(/\s+/g,' ').trim();
    if(query.startsWith('SELECT')&&query.includes('FROM parent_deletion_queue'))return [[]];
    if(query.startsWith('SELECT')&&query.includes('FROM parent_registration_attempts'))return [attempt?[attempt]:[]];
    if(query.startsWith('SELECT')&&query.includes('FROM parent_profiles'))return [profile?[profile]:[]];
    if(query.startsWith('SELECT')&&query.includes('FROM children'))return [[
      {child_id:'child-1',registered_first_name:'Лена',surname:'Тестовая'}
    ]];
    if(query.startsWith('SELECT')&&query.includes('FROM admissions'))return [[
      {admission_id:'adm-1',child_id:'child-1',status:matched?'active':'closed'}
    ]];
    if(query.startsWith('INSERT INTO parent_profiles')) {
      profile={phone10:values[0],parent_name:values[1],child_name:values[2],
        child_id:values[4],admission_id:values[5],profile_generation:values[6]};
      return [];
    }
    if(query.startsWith('INSERT INTO parent_auth_profiles')) {
      auth={phone10:values[0],user_handle:values[1],generation_id:values[2]};
      return [];
    }
    if(query.startsWith('INSERT INTO parent_registration_attempts')){
      attempt={attempt_id:values[0],phone10:values[1],parent_name:values[2],
        child_name:values[3],status:values[4]};
      return [];
    }
    throw new Error('Unexpected test SQL '+query);
   };
   tx.upsert=tx;
   return fn(tx);
  }};
  return {sql,state:()=>({attempt,profile,auth})};
}
test('registration completes immediately and preserves current parent-facing API',async()=>{
  const fake=fakeDatabase();
  let issued=0;
  const service=createParentRegistrationService({sql:fake.sql,now:()=>2000,
    sessions:{issueParent:async()=>{issued++;return {token:'signed',expiresAt:99999}}}});
  const result=await service.register(payload);
  assert.equal(result.ok,true);
  assert.equal(result.parentSession,'signed');
  assert.equal(fake.state().profile.child_id,'child-1');
  assert.equal(fake.state().attempt.status,'COMPLETED');
  assert.ok(fake.state().auth.user_handle);
  assert.equal(issued,1);
  const retry=await service.register(payload);
  assert.equal(retry.parentSession,'signed');
  const status=await service.status({phone:payload.phone,attemptId:payload.attemptId});
  assert.equal(status.status,'COMPLETED');
});
test('parent registration without a roster match still completes, without guessing a clinical association',async()=>{
  const fake=fakeDatabase({matched:false});
  const service=createParentRegistrationService({sql:fake.sql,now:()=>2000,
    sessions:{issueParent:async()=>({token:'signed',expiresAt:99999})}});
  const result=await service.register(payload);
  assert.equal(result.ok,true);
  assert.equal(fake.state().profile.child_name,'Лена Тестовая');
  assert.equal(fake.state().profile.admission_id,'');
  assert.equal(fake.state().profile.child_id,'');
});
test('attempt cannot be reused for a different parent',async()=>{
  const fake=fakeDatabase();
  const service=createParentRegistrationService({sql:fake.sql,now:()=>2000,
    sessions:{issueParent:async()=>({token:'signed'})}});
  await service.register(payload);
  await assert.rejects(()=>service.register({...payload,parentName:'Другой родитель'}),/collision/);
});
