const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

test('historic attribution remains protected but has no prominent educator settings tab',()=>{
  const ui=fs.readFileSync(path.join(root,'tutors/next-settings.js'),'utf8');
  const api=fs.readFileSync(path.join(root,'services/postgres-next/app/api-router.mjs'),'utf8');
  assert.doesNotMatch(ui,/medsiTabHistory|medsiHistoryPane|refreshHistoryReview|history-review\/assign/);
  for(const tab of ['medsiTabRaw','medsiTabChildren','medsiTabNames','medsiTabRoster'])
    assert.match(ui,new RegExp(tab));
  // Keep the guarded backend available for exceptional administrator recovery.
  assert.ok(api.includes("router.get('/admin/reports/history-review'"));
  assert.ok(api.includes('reportHistoryReview.assign('));
  assert.ok(api.includes('if(!await educator(req,res))return;'));
});
