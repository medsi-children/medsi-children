const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'..'),read=path=>fs.readFileSync(require('node:path').join(base,path),'utf8');

test('sign-in starts with a phone number and only prompts passkey when the backend requires it',()=>{
  const html=read('index.html'),js=read('parents/full-web.js');
  assert.match(html,/id="phoneInputAuth"/);
  assert.match(html,/id="passkeyRequiredPanel"[^>]*class="[^"]*hidden/);
  assert.doesNotMatch(html,/id="showPhoneAuthBtn"|id="phoneAuthFallback"/);
  assert.match(js,/showPasskeyRequired\(data\.phone\)/);
  const flow=js.slice(js.indexOf('async function runReauthorizationFlow'));
  assert.ok(flow.indexOf("res.code==='PASSKEY_REQUIRED'")<flow.indexOf("if(!res||res.ok===false)"),'passkey is handled before generic error');
  assert.match(js,/authentication\/options/);
  assert.match(js,/\{phone:chosen\}/);
});
test('passkey offer remains immediately after registration and phone grace is server-side',()=>{
  const frontend=read('parents/full-web.js'),server=read('services/postgres-next/app/parent-access.mjs');
  assert.match(frontend,/showChoose\(\);askToSavePasskey\(\)/);
  assert.match(server,/FIRST_DAY_MS=24\*60\*60\*1000/);
  assert.match(server,/auth\?\.created_at/);
});
