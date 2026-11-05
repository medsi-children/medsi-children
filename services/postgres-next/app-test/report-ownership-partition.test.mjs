import test from 'node:test';
import assert from 'node:assert/strict';
import {partitionReportOwnership} from '../src/report-ownership-partition.mjs';
const secret='synthetic-only-migration-audit-secret';
const profile={phone10:'9000000001',admission_id:'new-admission',profile_generation:'new-generation'};
const report={phone10:profile.phone10,kind:'morning',child_admission_id:profile.admission_id,
  profile_generation:'',text:'Вымышленный текст',updated_at:1700000000000};
const run=(current,history=[],profiles=[profile],historicalLinks=[])=>
  partitionReportOwnership({current,history,profiles,historicalLinks},secret);
test('current owner is accepted, orphan and previous admission are preserved without publication',()=>{
  const orphan={...report,phone10:'9000000002'},stale={...report,kind:'evening',child_admission_id:'old-admission'};
  const result=run([report,orphan,stale]);
  assert.deepEqual(result.current,[report]);assert.equal(result.background_jobs.length,2);
  assert.deepEqual(result.background_jobs.map(job=>JSON.parse(job.payload_json).record),[orphan,stale]);
  assert.ok(result.background_jobs.every(job=>job.status==='quarantined'&&job.next_attempt_at===null));
  assert.deepEqual(run([report,orphan,stale]),result);
});
test('history requires exact reviewed admission and generation; phone reuse cannot grant access',()=>{
  const old={...report,child_admission_id:'old-admission',report_date:'2026-01-01',captured_at:1700000000000};
  assert.equal(run([], [old]).background_jobs.length,1);
  assert.equal(run([], [old],[profile],[{...profile,admission_id:'old-admission'}]).history.length,1);
  assert.equal(run([], [old],[],[{...profile,admission_id:'old-admission'}]).background_jobs.length,1);
  assert.equal(run([{...report,profile_generation:'stale-generation'}]).background_jobs.length,1);
});
test('duplicate and malformed source rows block partition instead of disappearing',()=>{
  assert.throws(()=>run([report,report]),/Invalid/);
  assert.throws(()=>run([{...report,text:{}}]),/Invalid/);
  assert.throws(()=>run([{...report,phone10:'bad'}]),/Invalid/);
});
