const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('the reversible migration freeze is wired to HTTP and scheduled Cloudflare writers',()=>{
  const chat=read('services/cloudflare/chat-worker/src/index.js');
  const push=read('services/cloudflare/push-worker/src/index.js');
  assert.match(chat,/MIGRATION_WRITE_FREEZE/);
  assert.match(chat,/migrationFreezeResponse\(request,env\)/);
  assert.match(chat,/if \(env\.MEDSI_MIGRATION_FREEZE === '1'\) return;/);
  assert.match(push,/MIGRATION_WRITE_FREEZE/);
  assert.match(push,/migrationFreezeResponse\(request,env\)/);
});
