import test from 'node:test';
import assert from 'node:assert/strict';
import {seedSyntheticRoster,DEMO_CHILDREN,DEMO_PARENTS} from '../src/seed-demo.mjs';

function fake({occupied=false,seeded=false}={}) {
  let writes=[],selects=0;
  const sql={
    identifier:v=>({id:v}),
    begin:async(options,fn)=>fn(async(parts,...args)=>{
      const q=parts.join('?').replace(/\s+/g,' ');
      if(q.includes('SELECT') && q.includes('LIMIT 1')){
        selects++;
        if(q.includes('stand_bootstrap_state'))return seeded?[[{status:'complete'}]]:[[]];
        return occupied?[[{id:'existing-real-data'}]]:[[]];
      }
      if(q.includes('UPSERT INTO')){
        writes.push({q,args});
        return [[]];
      }
      throw new Error('Unknown test statement '+q);
    })
  };
  return {sql,state:()=>({writes,selects})};
}
test('synthetic seed refuses to touch a populated YDB database',async()=>{
  const db=fake({occupied:true});
  await assert.rejects(()=>seedSyntheticRoster(db),/entirely empty/);
  assert.equal(db.state().writes.length,0);
});
test('synthetic seed creates two children and three fictitious parents',async()=>{
  const db=fake();
  const result=await seedSyntheticRoster({...db,now:()=>10000});
  assert.equal(result.children,2);
  assert.equal(result.parents,3);
  assert.equal(db.state().selects,27);
  assert.equal(db.state().writes.length,2*2+3*2+1);
  assert.equal(DEMO_CHILDREN.length,2);
  assert.equal(DEMO_PARENTS.filter(x=>x.childIndex===0).length,2);
});
test('synthetic seed skips all data writes after the fixture marker exists',async()=>{
  const db=fake({seeded:true});
  const result=await seedSyntheticRoster(db);
  assert.equal(result.alreadySeeded,true);
  assert.equal(db.state().writes.length,0);
  assert.equal(db.state().selects,1);
});
