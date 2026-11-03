import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentDeletionService} from '../src/parent-deletion.mjs';

const phone='9991112233',operationId='del_12345678901234567890123';
function database() {
  let job=null,profile={phone10:phone,parent_name:'Родитель',
    child_id:'child-1',admission_id:'adm-1',profile_generation:'gen-1'};
  const sql={begin:async(_,fn)=>fn(async(strings,...params)=>{
    const query=strings.join('?').replace(/\\s+/g,' ').trim();
    if(query.startsWith('SELECT')&&query.includes('FROM parent_deletion_queue')){
      if(query.includes('operation_id=?'))return [job?[job]:[]];
      return [job?[job]:[]];
    }
    if(query.startsWith('SELECT')&&query.includes('FROM parent_profiles'))return [profile?[profile]:[]];
    if(query.startsWith('UPSERT INTO parent_deletion_queue')){
      job={operation_id:params[0],phone10:params[1],status:params[6],
        created_at:1000,updated_at:1000,attempts:0};
      return [];
    }
    if(query.startsWith('DELETE FROM parent_profiles')){profile=null;return [];}
    if(query.startsWith('UPDATE parent_access_requests'))return [];
    throw new Error('Unexpected test SQL: '+query);
  })};
  return {sql,state:()=>({job,profile})};
}
test('deletion fails closed when cleanup is not explicitly enabled',async()=>{
  const db=database();
  const service=createParentDeletionService({sql:db.sql,removeMedia:async()=>{}});
  await assert.rejects(()=>service.enqueue({phone,operationId}),/temporarily disabled/);
  assert.ok(db.state().profile);
});
test('staff deletion is idempotent and immediately revokes parent profile',async()=>{
  const db=database();
  const service=createParentDeletionService({sql:db.sql,enabled:true,
    now:()=>1000,removeMedia:async()=>{}});
  const first=await service.enqueue({phone,operationId});
  assert.equal(first.accepted,true);
  assert.equal(first.status,'pending');
  assert.equal(db.state().profile,null);
  assert.equal((await service.enqueue({phone,operationId})).duplicate,true);
});
