import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentDeletionService} from '../app/parent-deletion.mjs';

const phone='9991112233',operationId='del_12345678901234567890123';
function database({secondParent=false}={}) {
  const writes=[];
  let job=null,profile={phone10:phone,parent_name:'Родитель',
    child_id:'child-1',admission_id:'adm-1',profile_generation:'gen-1'};
  const sql={begin:async(_,fn)=>{
   const tx=async(strings,...params)=>{
    const query=strings.join('?').replace(/\\s+/g,' ').trim();
    if(query.startsWith('SELECT')&&query.includes('FROM parent_deletion_queue')){
      if(query.includes('AND status=')&&job?.status!=='completed')return [[]];
      if(query.includes('operation_id=?'))return [job?[job]:[]];
      return [job?[job]:[]];
    }
    if(query.startsWith('SELECT')&&query.includes('FROM parent_profiles'))return [profile?[profile]:(secondParent&&/WHERE (child_id|admission_id)/.test(query)?[{phone10:'9990000099'}]:[])];
    if(query.startsWith('SELECT')&&query.includes('FROM admissions'))return [[{admission_id:'adm-1'}]];
    if(query.startsWith('SELECT')&&query.includes('FROM children'))return [[{registered_first_name:'Тест',surname:'Тестовый'}]];
    if(query.includes('FROM name_variants')||query.includes('FROM report_ownership'))return [[]];
    if(query.startsWith('INSERT INTO report_ownership')||query.startsWith('DELETE FROM ')){
      if(!query.startsWith('DELETE FROM parent_profiles')){writes.push(query);return [];}
    }
    if(query.startsWith('INSERT INTO parent_deletion_queue')){
      job={operation_id:params[0],phone10:params[1],status:params[6],
        created_at:1000,updated_at:1000,attempts:0};
      return [];
    }
    if(query.startsWith('DELETE FROM parent_profiles')){profile=null;return [];}
    if(query.startsWith('UPDATE parent_access_requests'))return [];
    throw new Error('Unexpected test SQL: '+query);
   };
   tx.upsert=tx;
   return fn(tx);
  }};
  return {sql,state:()=>({job,profile}),writes};
}
test('deletion fails closed when cleanup is not explicitly enabled',async()=>{
  const db=database();
  const service=createParentDeletionService({sql:db.sql,removeMedia:async()=>{}});
  await assert.rejects(()=>service.enqueue({phone,operationId}),/temporarily disabled/);
  assert.ok(db.state().profile);
});
test('cached educator panels may submit the original delete_ operation IDs',async()=>{
  const db=database();
  const service=createParentDeletionService({sql:db.sql,enabled:true,
    now:()=>1000,removeMedia:async()=>{}});
  const legacyId='delete_1234567890abcdef1234567890abcdef';
  const answer=await service.enqueue({phone,operationId:legacyId});
  assert.equal(answer.ok,true);
  assert.equal(answer.accepted,true);
  assert.equal(answer.operationId,legacyId);
  assert.equal(db.state().profile,null);
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


test('last parent deletion purges clinical roster but never touches shared raw sources',async()=>{
 const db=database();await createParentDeletionService({sql:db.sql,enabled:true}).enqueue({phone,operationId});
 assert.ok(db.writes.some(q=>q.startsWith('DELETE FROM admissions')));
 assert.ok(db.writes.some(q=>q.startsWith('DELETE FROM children')));
 assert.ok(!db.writes.some(q=>q.includes('raw_reports')));
});
test('another guardian preserves the child and active admission',async()=>{
 const db=database({secondParent:true});await createParentDeletionService({sql:db.sql,enabled:true}).enqueue({phone,operationId});
 assert.ok(!db.writes.some(q=>q.startsWith('DELETE FROM admissions')||q.startsWith('DELETE FROM children')));
});

function childOnlyDatabase({hasParent=false}={}){
 const childId='child_001',admissionId='admission_001',writes=[];
 let exists=true;
 const tx=async(strings,...args)=>{
  const query=strings.join('?').replace(/\s+/g,' ').trim();
  if(query.startsWith('SELECT')){
   if(query.includes('FROM admissions WHERE admission_id='))return [exists?[{child_id:childId,status:'active'}]:[]];
   if(query.includes('FROM admissions WHERE child_id='))return [exists?[{admission_id:admissionId}]:[]];
   if(query.includes('FROM parent_profiles'))return [hasParent?[{phone10:'9000000001'}]:[]];
   if(query.includes('FROM children'))return [exists?[{registered_first_name:'Боря',surname:'Тестовый'}]:[]];
   if(/FROM (report_ownership|name_variants|parent_deletion_queue)/.test(query))return [[]];
   throw Error('Unexpected SELECT '+query);
  }
  writes.push(query);
  if(query.startsWith('DELETE FROM children'))exists=false;
  return [[]];
 };
 tx.upsert=tx;
 return {sql:{begin:async(_opts,fn)=>fn(tx)},writes,state:()=>exists,childId,admissionId};
}
test('educator can discharge a child without any registered parent',async()=>{
 const db=childOnlyDatabase();
 const service=createParentDeletionService({sql:db.sql,enabled:true,now:()=>1000});
 const result=await service.removeChildWithoutParents({childId:db.childId,admissionId:db.admissionId});
 assert.equal(result.removed,true);
 assert.equal(db.state(),false);
 assert.ok(db.writes.some(q=>q.startsWith('DELETE FROM admissions')));
 assert.ok(db.writes.some(q=>q.startsWith('DELETE FROM children')));
 assert.equal(db.writes.some(q=>q.includes('raw_reports')),false);
});
test('child discharge is blocked if any parent is still linked',async()=>{
 const db=childOnlyDatabase({hasParent:true});
 const service=createParentDeletionService({sql:db.sql,enabled:true,now:()=>1000});
 await assert.rejects(()=>service.removeChildWithoutParents({
  childId:db.childId,admissionId:db.admissionId
 }),/still has parent profiles/);
 assert.equal(db.state(),true);
 assert.equal(db.writes.length,0);
});
test('unlinked-child discharge respects the production deletion feature gate',async()=>{
 const db=childOnlyDatabase();
 const service=createParentDeletionService({sql:db.sql});
 await assert.rejects(()=>service.removeChildWithoutParents({
  childId:db.childId,admissionId:db.admissionId
 }),/temporarily disabled/);
 assert.equal(db.state(),true);
});
