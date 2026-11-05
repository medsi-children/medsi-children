const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const fullWeb=fs.readFileSync('tutors/full-web.js','utf8');
const settings=fs.readFileSync('tutors/next-settings.js','utf8');
const page=fs.readFileSync('tutors.html','utf8');

test('push settings recover from a transient unavailable state',()=>{
  const update=fullWeb.match(/async function updatePushControl\(\)\{([^\n]+)\}/)?.[1];
  assert.ok(update,'push control updater exists');
  assert.match(update,/button\.disabled=false/);
  assert.match(update,/button\.dataset\.enabled=''/);
  assert.match(update,/Notification\.permission==='denied'/);
});

test('child picker has no duplicate close button and still invokes legacy deletion',()=>{
  assert.doesNotMatch(settings,/medsiSettingPickerBack/);
  assert.match(settings,/openPicker\('Удалить ребёнка', 'deleteChildSelect', 'settingsDeleteChild'\)/);
  assert.match(settings,/action\.click\(\)/);
  assert.match(settings,/oldClose\.addEventListener\('click', closePicker\)/);
  assert.match(fullWeb,/\$\('tutorSettingsClose'\)\.addEventListener\('click',closeSettings\)/);
});

test('settings script cache version is refreshed',()=>{
  assert.match(page,/next-settings\.js\?v=20261105-settings-complete-10/);
});
