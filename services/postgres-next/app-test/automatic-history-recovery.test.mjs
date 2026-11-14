import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentReportBackfill} from '../app/current-report-backfill.mjs';

const today=Date.parse('2026-11-14T12:00:00Z');
const phone='9000000001',childId='child_synthetic_k';
const variants=[{base_key:'михаил',preferred_name:'Михаил',variants_json:'["Миша"]'}];
const source=(day,text,id)=>({
  publication_id:id,kind:'evening',report_date:day,
  normalized_text:text,revision:1n,submitted_at:Date.parse(day+'T18:00:00Z')
});
function fakeDb({legacy=true,blocked=false,namesake=false,anchor=true,competitorOwner=false,unlinkedCompetitor=false}={}){
  const parent={phone10:phone,child_id:childId,child_name:'Михаил Котов'};
  const profiles=[parent];
  if(unlinkedCompetitor)profiles.push({phone10:'9000000003',child_id:'',child_name:'Михаил Ковалёв'});
  const children=[{child_id:childId,registered_first_name:'Михаил',surname:'Котов'}];
  if(namesake)children.push({child_id:'child_other_k',registered_first_name:'Михаил',surname:'Казаков'});
  const raw=[
    source('2026-11-04','Миша К.: Запись за четвёртое ноября.','pub_legacy_04'),
    ...(anchor?[source('2026-11-11','Миша К.: Подтверждённая запись.','pub_owned_11')]:[]),
    ...(competitorOwner?[source('2026-11-07','Миша К.: Чужой отчёт.','pub_other_07')]:[])
  ];
  const owners=[];
  if(!legacy)owners.push({owner_key:'CURRENT_BLOCK_pub_legacy_04_0',
    record_json:JSON.stringify(blocked?{blocked:true}:{childId:'',pending:true,blocked:false})});
  if(anchor)owners.push({owner_key:'CURRENT_BLOCK_pub_owned_11_0',
    record_json:JSON.stringify({childId,blocked:false,pending:false})});
  if(competitorOwner)owners.push({owner_key:'CURRENT_BLOCK_pub_other_07_0',
    record_json:JSON.stringify({childId:'child_other_k',blocked:false,pending:false})});
  const history=[];
  const sql={begin:async(options,callback)=>{
    assert.equal(options.isolation,'serializableReadWrite');
    const query=async(strings,...values)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.startsWith('SELECT child_id FROM parent_profiles WHERE phone10='))return [[parent]];
      if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [children];
      if(q.startsWith('SELECT child_id,child_name FROM parent_profiles'))return [profiles];
      if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [variants];
      if(q.startsWith('SELECT publication_id,kind,report_date,normalized_text,submitted_at,revision FROM raw_reports'))return [raw];
      if(q.startsWith('SELECT owner_key,record_json FROM report_ownership WHERE owner_key LIKE'))return [owners];
      if(q.startsWith('SELECT kind,report_date,child_id FROM parent_report_history'))return [
        history.filter(h=>h.phone10===values[0])
      ];
      if(q.startsWith('UPDATE report_ownership SET record_json=')){
        const o=owners.find(row=>row.owner_key===values[2]&&row.record_json===values[3]);
        if(!o)return [[]];
        o.record_json=values[0];return [[{owner_key:o.owner_key}]];
      }
      if(q.startsWith('INSERT INTO report_ownership')){
        if(owners.some(row=>row.owner_key===values[0]))return [[]];
        owners.push({owner_key:values[0],record_json:values[1]});
        return [[{owner_key:values[0]}]];
      }
      if(q.startsWith('INSERT INTO parent_report_history')){
        const [phone10,kind,report_date,newChildId,publication_id,revision,text,captured_at]=values;
        const idx=history.findIndex(h=>h.phone10===phone10&&h.kind===kind&&h.report_date===report_date);
        const record={phone10,kind,report_date,child_id:newChildId,publication_id,revision,text,captured_at};
        if(idx>=0)history[idx]=record;else history.push(record);
        return [[]];
      }
      throw new Error('Unexpected SQL: '+q);
    };
    query.upsert=query;
    return callback(query);
  }};
  return {sql,history,owners};
}
const recover=options=>{
  const db=fakeDb(options);
  return {db,service:createCurrentReportBackfill(db.sql,{now:()=>today})};
};
const oldEntry=db=>db.history.find(h=>h.report_date==='2026-11-04');

test('legacy initialed report is recovered only with a verified later anchor',async()=>{
  const {db,service}=recover();
  const result=await service.recoverHistory({phone10:phone});
  assert.equal(result.backfilled,2);
  assert.match(oldEntry(db).text,/Запись за четвёртое ноября/);
  assert.equal(oldEntry(db).child_id,childId);
  assert.equal(db.owners.find(x=>x.owner_key==='CURRENT_BLOCK_pub_legacy_04_0')?.record_json.includes(childId),true);
  const again=await service.recoverHistory({phone10:phone});
  assert.equal(again.backfilled,0);
  assert.equal(db.history.length,2);
});

test('existing pending owner with one surname initial is claimed conservatively',async()=>{
  const {db,service}=recover({legacy:false});
  await service.recoverHistory({phone10:phone});
  assert.equal(oldEntry(db)?.child_id,childId);
});

test('historical source with no verified continuation is not assigned',async()=>{
  const {db,service}=recover({anchor:false});
  const result=await service.recoverHistory({phone10:phone});
  assert.equal(result.backfilled,0);
  assert.equal(oldEntry(db),undefined);
});

test('a blocked historical source is never reassigned',async()=>{
  const {db,service}=recover({legacy:false,blocked:true});
  await service.recoverHistory({phone10:phone});
  assert.equal(oldEntry(db),undefined);
});

test('namesakes sharing the same surname initial are not guessed',async()=>{
  const {db,service}=recover({namesake:true});
  await service.recoverHistory({phone10:phone});
  assert.equal(oldEntry(db),undefined);
});

test('a rival unlinked parent profile prevents initial-only assignment',async()=>{
  const {db,service}=recover({unlinkedCompetitor:true});
  await service.recoverHistory({phone10:phone});
  assert.equal(oldEntry(db),undefined);
});

test('a different child owning the same initial nearby blocks a legacy claim',async()=>{
  const {db,service}=recover({competitorOwner:true});
  await service.recoverHistory({phone10:phone});
  assert.equal(oldEntry(db),undefined);
});
