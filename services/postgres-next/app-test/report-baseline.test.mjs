import test from 'node:test';
import assert from 'node:assert/strict';
import {captureReportBaselineManifests,normalizeReportBaseline} from '../src/report-baseline.mjs';
import {captureDrainedOperationalManifests,DRAIN_STREAMS} from '../src/operational-drain.mjs';

const key='synthetic-only-manifest-key-0123456789';
const head={publication_id:'pub-1',kind:'morning',submitted_at:1700000000000,revision:1};
const input={nameRows:[['Тестолина','Тестуля']],raw:[{...head,report_date:'2025-11-01',
  raw_text:'Синтетический исходник',normalized_text:'Синтетический текст',author_id:'synthetic-author'}],
  heads:[head],submissions:[{...head,submission_id:'sub-1',payload_hash:'a'.repeat(64)}],
  ownership:[{owner_key:'synthetic-owner',record_json:'{"synthetic":true}',updated_at:1700000000000}]};

test('report baseline keeps raw text, variants, publication order and ownership',()=>{
  assert.equal(normalizeReportBaseline(input).raw_reports[0].raw_text,input.raw[0].raw_text);
  assert.deepEqual(captureReportBaselineManifests(input,key).map(item=>item.count),[1,1,1,1,1]);
  assert.throws(()=>normalizeReportBaseline({...input,heads:[{...head,revision:0}]}),/ambiguous/);
  assert.throws(()=>normalizeReportBaseline({...input,nameRows:[...input.nameRows,['Проверина','Тестуля']]}),/ambiguous/);
});

test('operational capture requires proof of emptiness for every stream',()=>{
  const empty=Object.fromEntries(DRAIN_STREAMS.map(stream=>[stream,[]]));
  assert.equal(captureDrainedOperationalManifests(empty,key).length,DRAIN_STREAMS.length);
  assert.throws(()=>captureDrainedOperationalManifests({},key),/every operational/);
  assert.throws(()=>captureDrainedOperationalManifests({...empty,push_outbox:[{}]},key),/push_outbox/);
});
