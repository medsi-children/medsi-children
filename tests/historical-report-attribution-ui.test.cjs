const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');

test('educator history review has an explicit confirmation UI and protected endpoints',()=>{
  const ui=fs.readFileSync(path.join(root,'tutors/next-settings.js'),'utf8');
  const api=fs.readFileSync(path.join(root,'services/postgres-next/app/api-router.mjs'),'utf8');
  assert.match(ui,/medsiTabHistory/);
  assert.match(ui,/admin\/reports\/history-review\/assign/);
  assert.match(ui,/confirm\('Подтвердить этот блок/);
  assert.match(api,/router\.get\('\/admin\/reports\/history-review'/);
  assert.match(api,/if\(!await educator\(req,res\)\)return;[\s\S]*?reportHistoryReview\.assign/);
});
