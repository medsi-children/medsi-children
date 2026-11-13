import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentReportHistoryReview} from '../app/current-report-history-review.mjs';

const today=Date.parse('2026-11-13T12:00:00Z');
function database(){
  const profiles=[{phone10:'9000000001',parent_name:'Родитель Тест',child_name:'Анфиса Иванова',child_id:'',profile_generation:'reg_synthetic_123456'}];
  const children=[],variants=[],raw=[{publication_id:'pub_synthetic_001',kind:'evening',report_date:'2026-11-12',normalized_text:'Анфиса Ив.: Синтетическое наблюдение.',submitted_at:today-86400000,revision:1n}];
  const owners=[{owner_key:'CURRENT_BLOCK_pub_synthetic_001_0',record_json:'{"childId":"","pending":true,"blocked":false}'}],history=[];
  const sql={begin:async(_options,fn)=>fn(Object.assign(async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(q.startsWith('SELECT phone10,parent_name,child_name,child_id,profile_generation'))return [profiles];
    if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [children];
    if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [variants];
    if(q.startsWith('SELECT publication_id,kind,report_date,normalized_text,submitted_at,revision FROM raw_reports'))return [raw];
    if(q.startsWith('SELECT owner_key,record_json FROM report_ownership WHERE owner_key LIKE'))return [owners];
    if(q.startsWith('SELECT phone10,kind,report_date,child_id,publication_id FROM parent_report_history'))return [history];
    if(q.startsWith('SELECT record_json FROM report_ownership WHERE owner_key=')&&q.includes('FOR UPDATE'))return [owners.filter(x=>x.owner_key===values[0])];
    if(q.startsWith('UPDATE parent_profiles SET child_id=')){const p=profiles.find(x=>x.phone10===values[2]&&!x.child_id&&x.profile_generation===values[5]);if(p){p.child_id=values[0];return [[{phone10:p.phone10}]]}return [[]];}
    if(q.startsWith('UPDATE parent_registration_attempts'))return [[]];
    if(q.startsWith('UPDATE report_ownership SET record_json=')){const row=owners.find(x=>x.owner_key===values[2]&&x.record_json===values[3]);if(row){row.record_json=values[0];return [[{owner_key:row.owner_key}]]}return [[]];}
    if(q.startsWith('INSERT INTO report_ownership')){owners.push({owner_key:values[0],record_json:values[1]});return [[{owner_key:values[0]}]];}
    if(q.startsWith('INSERT INTO parent_report_history')){history.push({phone10:values[0],kind:values[1],report_date:values[2],child_id:values[3],publication_id:values[4],revision:values[5],text:values[6],captured_at:values[7]});return [[{phone10:values[0]}]];}
    throw new Error('Unexpected SQL: '+q);
  },{upsert:async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(q.startsWith('INSERT INTO children')){children.push({child_id:values[0],registered_first_name:values[1],surname:values[2]});return [[]];}
    throw new Error('Unexpected write: '+q);
  }}))};
  return {sql,profiles,children,owners,history};
}

test('educator assignment links a late parent and restores one historical block atomically',async()=>{
  const db=database(),service=createCurrentReportHistoryReview(db.sql,{now:()=>today});
  const listed=await service.list();assert.equal(listed.items.length,1);
  const item=listed.items[0],target=item.candidates[0];assert.equal(target.key,'parent:9000000001');
  await assert.rejects(()=>service.assign({publicationId:item.publicationId,blockIndex:item.blockIndex,token:'stale-token',targetKey:target.key}),/Report source or roster changed/);
  const result=await service.assign({publicationId:item.publicationId,blockIndex:item.blockIndex,token:item.token,targetKey:target.key});
  assert.equal(result.assigned,true);assert.equal(db.profiles[0].child_id,db.children[0].child_id);
  assert.equal(db.history.length,1);assert.equal(db.history[0].publication_id,item.publicationId);
  assert.match(db.history[0].text,/Синтетическое наблюдение/);
  assert.match(db.owners[0].record_json,new RegExp(db.children[0].child_id));
  const replay=await service.assign({publicationId:item.publicationId,blockIndex:item.blockIndex,token:item.token,targetKey:target.key});
  assert.equal(replay.duplicate,true);assert.equal(db.history.length,1);
});

test('assignment refuses a stale source and exposes no candidate on a namesake mismatch',async()=>{
  const db=database(),service=createCurrentReportHistoryReview(db.sql,{now:()=>today});
  db.profiles[0].child_name='Борис Иванов';
  assert.equal((await service.list()).items.length,0);
});
