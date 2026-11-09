import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentChildLinkStore} from '../app/current-child-link-store.mjs';

const now=Date.parse('2026-11-09T12:00:00Z');
function fakeDB({profiles=[],children=[],sources=[]}={}){
  const rows={profiles:structuredClone(profiles),children:structuredClone(children),
    publications:structuredClone(sources),attempts:[],auth:new Set(profiles.map(p=>p.phone10))};
  const queries=[];
  const tx=async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    queries.push(q);
    if(/FROM admissions/i.test(q)||/admission_id/i.test(q))
      throw new Error('Admission dependency regression: '+q);
    if(q.startsWith('SELECT')){
      if(q.includes('FROM parent_profiles'))return [q.includes('WHERE phone10=')?
        rows.profiles.filter(p=>p.phone10===values[0]):rows.profiles];
      if(q.includes('FROM parent_auth_profiles'))return [q.includes('WHERE phone10=')?
        [...rows.auth].filter(x=>x===values[0]).map(phone10=>({phone10})):
        [...rows.auth].map(phone10=>({phone10}))];
      if(q.includes('FROM children'))return [rows.children];
      if(q.includes('FROM name_variants'))return [[
        {preferred_name:'Степан',variants_json:'["Стёпа"]'}]];
      if(q.includes('FROM report_publication_head'))return [rows.publications];
      return [[]];
    }
    if(q.startsWith('UPDATE parent_profiles')){
      const p=rows.profiles.find(p=>p.phone10===values[2]&&!p.child_id);
      if(!p)return [[]];
      p.child_id=values[0];return [[{phone10:p.phone10}]];
    }
    if(q.startsWith('UPDATE parent_registration_attempts'))return [[]];
    throw new Error('Unexpected SQL '+q);
  };
  tx.upsert=async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    queries.push(q);
    if(!q.startsWith('INSERT INTO children'))throw new Error('Unexpected upsert '+q);
    rows.children.push({child_id:values[0],registered_first_name:values[1],
      surname:values[2]});
    return [[]];
  };
  return {sql:{begin:async(_opts,fn)=>fn(tx)},rows,queries};
}
const pub=(name,kind='morning',date='2026-11-09')=>({publication_id:'p_'+kind,
  kind,report_date:date,submitted_at:now-100,normalized_text:name});
const parent=(phone10,childName,child_id='')=>({phone10,child_name:childName,
  child_id,profile_generation:'reg_'+phone10});
test('late parent creates only one registered child row, never an admission',async()=>{
  const db=fakeDB({profiles:[parent('9000000001','Степан Сидоров')],
    sources:[pub('Степан — Занимался.')]});
  const service=createCurrentChildLinkStore(db.sql,{now:()=>now});
  assert.deepEqual(await service.reconcile(),{ok:true,linked:1,pending:0,ambiguous:0});
  assert.equal(db.rows.children.length,1);
  assert.equal(db.rows.profiles[0].child_id,db.rows.children[0].child_id);
  assert.equal(db.rows.children[0].surname,'Сидоров');
  assert.ok(db.queries.every(q=>!q.includes('admission')));
});
test('both parents receive same active child identity',async()=>{
  const db=fakeDB({children:[{child_id:'kid_12345678',registered_first_name:'Степан',surname:'Сидоров'}],
    profiles:[parent('9000000001','Степан Сидоров','kid_12345678'),
      parent('9000000002','Стёпа Сидоров')],sources:[]});
  const res=await createCurrentChildLinkStore(db.sql,{now:()=>now}).reconcile({phone10:'9000000002'});
  assert.equal(res.linked,1);
  assert.equal(db.rows.profiles[1].child_id,'kid_12345678');
  assert.equal(db.rows.children.length,1);
});
test('parent registered before source stays unlinked and connects after new source',async()=>{
  const db=fakeDB({profiles:[parent('9000000001','Степан Сидоров')]});
  const service=createCurrentChildLinkStore(db.sql,{now:()=>now});
  assert.equal((await service.reconcile()).linked,0);
  db.rows.publications.push(pub('Степан — На прогулке.'));
  assert.equal((await service.reconcile()).linked,1);
  assert.equal((await service.reconcile()).linked,0);
});
test('deleting previous parent removes old competitor from live roster',async()=>{
  const db=fakeDB({profiles:[parent('9000000001','Степан Сидоров')],
    children:[{child_id:'old_child',registered_first_name:'Степан',surname:'Мерцалов'}],
    sources:[pub('Степан — Сегодня активен.')]});
  const result=await createCurrentChildLinkStore(db.sql,{now:()=>now}).reconcile();
  assert.equal(result.linked,1);
  assert.notEqual(db.rows.profiles[0].child_id,'old_child');
  assert.equal(db.rows.children.length,2); // Legacy residue ignored, cleanup is separate.
});
test('ambiguous same-prefix group never creates a registered child',async()=>{
  const db=fakeDB({profiles:[parent('9000000001','Степан Сидоров')],
    sources:[pub('Степан С. — Первый.\nСтепан С. — Второй.')]});
  const result=await createCurrentChildLinkStore(db.sql,{now:()=>now}).reconcile();
  assert.equal(result.linked,0);
  assert.equal(result.ambiguous,1);
  assert.equal(db.rows.children.length,0);
});
