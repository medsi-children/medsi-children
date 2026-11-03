import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentAccessService} from '../src/parent-access.mjs';

const phone='9991112233';
function database(){
  let request=null;
  const child={registered_first_name:'Лена',surname:'Тестовая'};
  const sql={begin:async(_,fn)=>fn(async(strings,...params)=>{
    const query=strings.join('?').replace(/\\s+/g,' ').trim();
    if(query.startsWith('SELECT')&&query.includes('FROM parent_profiles')){
      return [[{phone10:phone,parent_name:'Мария Тестовая',child_id:'child-1'}]];
    }
    if(query.startsWith('SELECT')&&query.includes('FROM parent_auth_profiles'))return [[{user_handle:'handle-1'}]];
    if(query.startsWith('SELECT')&&query.includes('FROM parent_passkeys'))return [[]];
    if(query.startsWith('SELECT')&&query.includes('FROM parent_access_requests'))return [request?[{...request}]:[]];
    if(query.startsWith('SELECT')&&query.includes('FROM children'))return [[child]];
    if(query.startsWith('UPSERT INTO parent_access_requests')){
      request={request_id:params[0],phone10:params[1],request_secret_hash:params[2],
        status:params[3],decision:params[4],created_at:1000,updated_at:1000,expires_at:1000+86400000};
      return [];
    }
    if(query.startsWith('UPDATE parent_access_requests')){
      const status=params[0];
      request.status=status;request.updated_at=1000;
      return [];
    }
    throw new Error('Unexpected test SQL: '+query);
  })};
  return sql;
}
test('staff approval required before new parent session is issued',async()=>{
  let issued=0;
  const sessions={issueParent:async()=>{issued++;return {token:'signed',expiresAt:99999}}};
  const service=createParentAccessService({sql:database(),sessions,now:()=>2000});
  const input={phone:'8'+phone,requestId:'auth_1234567890123456789012',requestSecret:'z'.repeat(48)};
  assert.deepEqual(await service.request(input),{ok:true,status:'PENDING'});
  assert.equal((await service.status(input)).status,'PENDING');
  assert.equal(issued,0);
  assert.equal((await service.status({...input,requestSecret:'y'.repeat(48)})).status,'NOT_FOUND');
  assert.equal((await service.decide({requestId:input.requestId,decision:'APPROVE'})).status,'APPROVED');
  const approved=await service.status(input);
  assert.equal(approved.status,'APPROVED');
  assert.equal(approved.parentSession,'signed');
  assert.equal(issued,1);
});
test('invalid secret and identifier are refused',async()=>{
  const s=createParentAccessService({sql:database(),sessions:{issueParent:async()=>({})}});
  await assert.rejects(()=>s.request({phone,requestId:'auth_short',requestSecret:'abc'}),/Invalid recovery request/);
});
