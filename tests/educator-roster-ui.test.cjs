const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('roster is available and phone/new-message screens cannot delete a profile',()=>{
  const html=read('tutors/next-settings.js'),phones=read('tutors/full-web.js'),newChat=read('chat-overlay/educator-new-chat.js');
  assert.match(html,/id="medsiTabRoster"/);
  assert.match(html,/id="medsiRosterPane"/);
  assert.match(html,/\/lab\/admin\/roster\/edit/);
  assert.doesNotMatch(phones,/card\.append\(title,del,meta,actions\)/);
  assert.doesNotMatch(newChat,/card\.append\(name,del,info\)/);
});


test('approved minimalist educator settings preserve reports, compact roster and child carousel',()=>{
  const js=read('tutors/next-settings.js'),css=read('tutors/next-settings.css'),html=read('tutors.html');
  assert.match(js,/Дети и родители/);
  assert.match(js,/medsi-child-deck-nav/);
  assert.match(js,/childPageIndex/);
  assert.match(js,/medsi-roster-line-actions/);
  assert.match(js,/medsi-raw-wave/);
  assert.match(js,/formatDisplayDate/);
  assert.match(js,/medsi-report-copy/);
  assert.doesNotMatch(js,/Групп имён:/);
  assert.match(css,/medsi-setting-tile/);
  assert.match(css,/aspect-ratio:auto!important/);
  assert.match(css,/medsi-tile-push\[data-enabled="1"\]/);
  assert.match(css,/medsi-roster-status-icon/);
  assert.match(html,/next-settings\.css\?v=20261105-settings-release-7/);
  assert.match(html,/next-settings\.js\?v=20261105-settings-release-7/);
});
