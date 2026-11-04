import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeD1Reports,captureD1ReportManifests} from '../src/d1-report-capture.mjs';

const profile={phone10:'9000000001',profile_generation:'new-generation',admission_id:'new-stay'};
const old={...profile,profile_generation:'old-generation',admission_id:'old-stay'};
const current={phone10:profile.phone10,kind:'morning',text:'Вымышленный отчёт',version:'v2',
  read_version:'v1',updated_at:1700000000000,revision:2,publication_id:'p2',
  profile_generation:profile.profile_generation,child_admission_id:profile.admission_id};
const history={...current,report_date:'2025-10-01',captured_at:1600000000000,
  profile_generation:old.profile_generation,child_admission_id:old.admission_id};

test('reports preserve exact read markers and approved historical admission',()=>{
  const result=normalizeD1Reports([current],[history],[profile],[old]);
  assert.equal(result.parent_current_reports[0].read_version,'v1');
  assert.equal(result.parent_current_reports[0].admission_id,'new-stay');
  assert.equal(result.parent_report_history[0].admission_id,'old-stay');
  assert.deepEqual(captureD1ReportManifests([current],[history],[profile],[old],
    'synthetic-only-manifest-key-0123456789').map(x=>x.count),[1,1]);
});

test('old reports cannot become current and ambiguous history is rejected',()=>{
  assert.throws(()=>normalizeD1Reports([history],[],[profile],[old]),/ambiguous/);
  assert.throws(()=>normalizeD1Reports([current],[history],[profile]),/ambiguous/);
  assert.throws(()=>normalizeD1Reports([current],[history,history],[profile],[old]),/ambiguous/);
  assert.throws(()=>normalizeD1Reports([current],[{...history,report_date:'2025-02-30'}],[profile],[old]),/ambiguous/);
});
