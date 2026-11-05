import test from 'node:test';
import assert from 'node:assert/strict';
import {createEducatorReportEditsStore} from '../app/educator-report-edits.mjs';

function fixture(active=true, exists=true) {
  const calls=[];
  const tx=async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim(); calls.push({q,values});
    if(q.startsWith('SELECT p.phone10'))return [active?[{phone10:'9000000001',admission_id:'admission_001',status:'active'}]:[]];
    if(q.startsWith('SELECT publication_id'))return [exists?[{publication_id:'publication_001',revision:2,text:'old'}]:[]];
    if(q.startsWith('SELECT report_date'))return [[{report_date:'2026-11-04'}]];
    return [[]];
  };
  tx.upsert=tx;
  const sql={begin:async(opts,fn)=>{assert.equal(opts.isolation,'serializableReadWrite');return fn(tx)}};
  return {store:createEducatorReportEditsStore(sql),calls};
}
const input={phone10:'9000000001',admissionId:'admission_001',kind:'morning',text:'Исправленный текст'};

test('post-publication correction updates only the authorized active admission and its visible history',async()=>{
  const {store,calls}=fixture(); const result=await store.update(input);
  assert.equal(result.ok,true); assert.match(result.version,/^[a-f0-9]{64}$/);
  assert.ok(calls.some(x=>x.q.startsWith('UPDATE parent_current_reports')));
  assert.ok(calls.some(x=>x.q.startsWith('INSERT INTO parent_report_history')));
  assert.equal(calls.some(x=>x.q.includes('push_outbox')),false);
  assert.ok(calls.some(x=>x.q.includes('p.child_id=a.child_id')));
});
test('clearing a distributed report also clears its historical copy',async()=>{
  const {store,calls}=fixture();
  await store.update({...input,text:''});
  const history=calls.find(x=>x.q.startsWith('INSERT INTO parent_report_history'));
  assert.ok(history);
  assert.equal(history.values[6],'');
});
test('correction fails closed for inactive recipient or missing current report',async()=>{
  await assert.rejects(()=>fixture(false).store.update(input),/no longer active/);
  await assert.rejects(()=>fixture(true,false).store.update(input),/not found/);
});
test('correction rejects malformed identity, type, and oversized content before SQL',async()=>{
  const {store,calls}=fixture();
  await assert.rejects(()=>store.update({...input,phone10:'12'}),/Invalid/);
  await assert.rejects(()=>store.update({...input,kind:'unknown'}),/Invalid/);
  await assert.rejects(()=>store.update({...input,text:'x'.repeat(240001)}),/Invalid/);
  await assert.rejects(()=>store.update({...input,text:{value:'bad'}}),/Invalid/);
  await assert.rejects(()=>store.update({...input,text:null}),/Invalid/);
  assert.equal(calls.length,0);
});
