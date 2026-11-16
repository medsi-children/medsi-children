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

test('entry screen favors registration and login warns about repeat admissions',()=>{
  const html=read('index.html'),css=read('parents/full-web.css'),js=read('parents/full-web.js');
  const start=html.slice(html.indexOf('<section id="screenStart"'),html.indexOf('<section id="screenNames"'));
  const auth=html.slice(html.indexOf('<section id="screenAuth"'),html.indexOf('<section id="screenRegistrationPending"'));
  assert.ok(start.includes('id="btnGoRegister"')&&start.includes('id="btnGoAuth"'));
  assert.ok(start.indexOf('id="btnGoRegister"')<start.indexOf('id="btnGoAuth"'));
  assert.match(start,/id="btnGoRegister"[^>]*class="[^"]*primary[^"]*"[^>]*>Зарегистрироваться<\/button>/);
  assert.match(start,/Уже регистрировались\? <button id="btnGoAuth" class="start-signin-link"[^>]*>Войти<\/button>/);
  assert.doesNotMatch(start,/id="btnGoAuth"[^>]*class="[^"]*primary/);
  assert.match(auth,/<h2 class="form-title">Вход в кабинет<\/h2>/);
  assert.match(auth,/Введите номер телефона, который указывали при регистрации\./);
  assert.match(auth,/Поступаете повторно\?/);
  assert.match(auth,/Если ребёнок уже выписывался и поступил снова, необходимо зарегистрироваться заново\. После выписки предыдущий профиль удаляется\./);
  assert.match(auth,/id="authRepeatRegisterBtn"[^>]*>Перейти к регистрации<\/button>/);
  assert.ok(auth.indexOf('id="authRepeatRegisterBtn"')<auth.indexOf('id="phoneInputAuth"'));
  assert.match(css,/#screenStart \.start-primary-register\{/);
  assert.match(css,/#screenStart \.start-signin-link\{/);
  assert.match(css,/#screenAuth \.auth-readmission-note\{/);
  assert.match(js,/\$\('authRepeatRegisterBtn'\)\.onclick=switchToRegistration/);
  assert.match(html,/parents\/full-web\.css\?v=20261116-registration-priority-1/);
  assert.match(html,/parents\/full-web\.js\?v=20261116-registration-priority-1/);
});
