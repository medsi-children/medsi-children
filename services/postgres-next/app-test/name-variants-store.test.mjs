import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeVariantRow,createNameVariantsStore} from '../app/name-variants-store.mjs';

test('NAME_VARIANTS keeps first column as raw-heading preference and normalizes aliases',()=>{
  const row=normalizeVariantRow({preferredName:'Катя',variants:'Екатерина, Катя, КАТЯ'});
  assert.equal(row.preferredName,'Катя');
  assert.equal(row.baseKey,'катя');
  assert.deepEqual(row.variants.slice(0,2),['КАТЯ','Екатерина']);
});
test('invalid and potentially ambiguous name entries fail closed',()=>{
  assert.throws(()=>normalizeVariantRow({preferredName:'Катя И.',variants:[]}),/русское имя/);
  assert.throws(()=>normalizeVariantRow({preferredName:'Катя',variants:'Екатерина, Саша; Ёжик2'}),/русское имя/);
});
function fixture(){
  const data=new Map([['катя',{base_key:'катя',preferred_name:'Катя',variants_json:'["Катя","Екатерина"]'}]]);
  const sql={async begin(_opts,callback){
    const next=new Map(data);
    const tx=async(strings,...params)=>{
      const q=strings.join(' ').replace(/\s+/g,' ').trim();
      if(q.startsWith('LOCK'))return [[]];
      if(q.includes('FROM report_ownership'))return [[]];
      if(q.startsWith('INSERT INTO report_ownership'))return [[]];
      if(q==='DELETE FROM name_variants'){next.clear();return [[]];}
      if(q.startsWith('SELECT'))return [[...next.values()]];
      if(q.startsWith('INSERT')){next.set(params[0],{base_key:params[0],preferred_name:params[1],variants_json:params[2]});return [[]]}
      if(q.startsWith('DELETE')){next.delete(params[0]);return [[]]}
      throw Error('Unexpected SQL '+q);
    };
    tx.upsert=tx;
    const value=await callback(tx);data.clear();for(const [k,v] of next)data.set(k,v);
    return value;
  }};
  return {data,sql};
}
test('cannot claim an alias already mapped to a different preferred name',async()=>{
  const {data,sql}=fixture();const store=createNameVariantsStore(sql);
  await assert.rejects(()=>store.save({preferredName:'Лена',variants:'Екатерина, Елена'}),/другой группе/);
  assert.equal(data.size,1);
  const result=await store.save({preferredName:'Лена',variants:'Елена'});
  assert.equal(result.baseKey,'лена');
  assert.equal(data.size,2);
  const list=await store.list();
  assert.equal(list.items.length,2);
});

test('draft name list saves atomically and rejects stale versions and new overlap',async()=>{
 const {sql,data}=fixture(),store=createNameVariantsStore(sql),before=await store.list();
 const next={revision:before.revision,items:[{previousBaseKey:'катя',preferredName:'Катя',variants:['Екатерина','Катюша']},{preferredName:'Миша',variants:['Михаил']}]};
 await store.replaceAll(next);assert.equal(data.size,2);assert.match(data.get('катя').variants_json,/Катюша/);
 await assert.rejects(()=>store.replaceAll(next),/revision/);
 const current=await store.list();
 await assert.rejects(()=>store.replaceAll({revision:current.revision,items:[{preferredName:'Лена',variants:['Тестуля']},{preferredName:'Оля',variants:['Тестуля']}]}),/overlapping/);
 assert.equal(data.size,2);
});
