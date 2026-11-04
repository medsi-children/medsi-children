import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentAccessService} from '../app/parent-access.mjs';

const phone='9991112233';
function fakeDatabase({hasPasskey=false,profileExists=true}={}) {
  const sql={begin:async(_opts,fn)=>fn(async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(q.includes('FROM parent_profiles'))return [profileExists?[{
      phone10:phone,parent_name:'Мария Тестовая',
      child_name:'Лена Тестовая',child_id:''
    }]:[]];
    if(q.includes('FROM parent_auth_profiles'))return [[{user_handle:'handle-1'}]];
    if(q.includes('FROM parent_passkeys'))return [hasPasskey?[{credential_id:'credential-1',revoked_at:0}]:[]];
    throw new Error('Unexpected test SQL '+q);
  })};
  return sql;
}
test('old phone-only recovery returns a session without educator approval',async()=>{
  let issued=0;
  const service=createParentAccessService({sql:fakeDatabase(),sessions:{
    issueParent:async()=>{issued++;return {token:'signed',expiresAt:99999}}}});
  const input={phone:'8'+phone,requestId:'auth_1234567890123456789012',requestSecret:'x'.repeat(48)};
  const response=await service.request(input);
  assert.equal(response.status,'APPROVED');
  assert.equal(response.parentSession,'signed');
  assert.equal(response.childName,'Лена Тестовая');
  assert.equal(issued,1);
  assert.equal((await service.status(input)).status,'APPROVED');
  assert.deepEqual(await service.listPending(),{ok:true,requests:[]});
  assert.equal((await service.decide()).code,'PARENT_APPROVAL_DISABLED');
});
test('existing Face ID credential prevents phone-based recovery',async()=>{
  let issued=0;
  const service=createParentAccessService({sql:fakeDatabase({hasPasskey:true}),sessions:{
    issueParent:async()=>{issued++;return {token:'signed'}}}});
  const result=await service.request({phone});
  assert.equal(result.code,'PASSKEY_REQUIRED');
  assert.equal(issued,0);
});
test('unknown phone cannot enter another parent profile',async()=>{
  const service=createParentAccessService({sql:fakeDatabase({profileExists:false}),sessions:{
    issueParent:async()=>({token:'signed'})}});
  assert.equal((await service.request({phone})).code,'NOT_FOUND');
});
