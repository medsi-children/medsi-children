import test from 'node:test';
import assert from 'node:assert/strict';
import {createOrphanChildCleanup} from '../app/orphan-child-cleanup.mjs';
import {sourcesAfterDeletion} from '../app/deleted-source-guard.mjs';
function harness(){
 const children=[{child_id:'orphan',registered_first_name:'Тест',surname:'Удалённый'},{child_id:'kept',registered_first_name:'Ира',surname:'Тестовая'}];
 const admissions=[{admission_id:'old',child_id:'orphan',status:'active'},{admission_id:'current',child_id:'kept',status:'active'}];
 const profiles=[{phone10:'9990000001',child_id:'kept',admission_id:'current'},{phone10:'9990000002',child_id:'',admission_id:''}];
 const writes=[];
 const tx=async(strings,...args)=>{
  const q=strings.join('?').replace(/\s+/g,' ').trim();
  if(q.startsWith('SELECT')){
   if(q.includes('FROM children'))return [q.includes('WHERE child_id=')?children.filter(c=>c.child_id===args[0]):[...children]];
   if(q.includes('FROM admissions'))return [q.includes('WHERE child_id=')?admissions.filter(a=>a.child_id===args[0]):[...admissions]];
   if(q.includes('FROM parent_profiles'))return [q.includes('WHERE child_id=')?profiles.filter(p=>p.child_id===args[0]):q.includes('WHERE admission_id=')?profiles.filter(p=>p.admission_id===args[0]):[...profiles]];
   if(/FROM (report_ownership|parent_deletion_queue|parent_auth_profiles|name_variants|parent_current_reports|report_publication_head)/.test(q))return [[]];
  }
  if(q.startsWith('DELETE')){
   writes.push(q);
   if(q.startsWith('DELETE FROM children'))children.splice(children.findIndex(c=>c.child_id===args[0]),1);
   if(q.startsWith('DELETE FROM admissions')){const i=admissions.findIndex(a=>a.child_id===args[0]);if(i>=0)admissions.splice(i,1);}
   return [[]];
  }
  throw Error('Unexpected synthetic SQL '+q);
 };
 tx.upsert=tx;
 return {sql:{begin:async(_opts,fn)=>fn(tx)},children,admissions,profiles,writes};
}
test('orphan cleanup preview is read-only and execution preserves linked and unlinked registered parents',async()=>{
 const h=harness(),service=createOrphanChildCleanup(h.sql,{now:()=>1000,enabled:true});
 assert.deepEqual(await service.preview(),{ok:true,candidates:1,removed:0,executed:false});
 assert.equal(h.writes.length,0);
 assert.deepEqual(await service.execute(),{ok:true,candidates:1,removed:1,executed:true});
 assert.deepEqual(h.children.map(c=>c.child_id),['kept']);
 assert.deepEqual(h.admissions.map(a=>a.admission_id),['current']);
 assert.equal(h.profiles.length,2);
 assert.ok(h.writes.every(q=>!q.includes('raw_reports')));
 assert.equal((await service.execute()).removed,0);
});
test('deleted child source fence permits fresh publications and prevents old raw source from re-enrolling the child',async()=>{
 const tx=async()=>[[{record_json:JSON.stringify({cutoff:1000})}]];
 const reports=[{submitted_at:999},{submitted_at:1000},{submitted_at:1001}];
 assert.deepEqual(await sourcesAfterDeletion(tx,'Тест',reports),[reports[2]]);
});

test('bulk cleanup respects the production deletion gate',async()=>{const h=harness();await assert.rejects(()=>createOrphanChildCleanup(h.sql).execute(),/temporarily disabled/);assert.equal(h.writes.length,0);});
