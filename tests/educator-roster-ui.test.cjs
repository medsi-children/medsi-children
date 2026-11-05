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
  assert.match(css,/One authoritative stylesheet/);
  assert.match(css,/\.medsi-tutor-reports \.medsi-child-report-pill/);
  assert.doesNotMatch(css,/dark layered Settings tiles/);
  assert.match(css,/medsi-tile-push\[data-enabled="1"\]/);
  assert.match(css,/medsi-roster-status-icon/);
  assert.match(html,/next-settings\.css\?v=20261106-square-child-card-13/);
  assert.match(html,/next-settings\.js\?v=20261105-roster-tooltips-11/);
});

test('deleting the final linked parent removes the child directory row',()=>{
  const js=read('tutors/next-settings.js');
  assert.match(js,/child\.parents\.length>0/);
  assert.match(js,/for\(const parent of parents\)/);
  assert.match(js,/parent-delete/);
  assert.match(js,/accepted!==true/);
  assert.doesNotMatch(js,/let parent=parents\[0\]/);
});
test('red settings tile retains the original child deletion picker',()=>{
  const js=read('tutors/next-settings.js');
  assert.match(js,/<span class="medsi-tile-heading">Удалить ребёнка<\/span>/);
  assert.match(js,/openPicker\('Удалить ребёнка', 'deleteChildSelect', 'settingsDeleteChild'\)/);
});

test('roster status is shown above the corresponding icon instead of a global banner',()=>{
  const js=read('tutors/next-settings.js'),css=read('tutors/next-settings.css');
  assert.match(js,/button\.dataset\.tooltip=tooltip/);
  assert.match(js,/Утреннего отчёта нет/);
  assert.match(js,/Вечернего отчёта нет/);
  assert.match(js,/medsi-roster-tooltip-open/);
  assert.doesNotMatch(js,/medsiReportsFeedback'\)\.textContent=button\.getAttribute\('aria-label'\)/);
  assert.match(css,/\.medsi-roster-status-icon::after/);
  assert.match(css,/content:attr\(data-tooltip\)/);
  assert.match(css,/bottom:calc\(100% \+ 12px\)/);
});

test('mobile child identity stays centered and aliases have compact readable rows',()=>{
  const css=read('tutors/next-settings.css');
  assert.match(css,/\.medsi-child-deck-details\{gap:8px;width:max-content;max-width:100%;margin-inline:auto;justify-items:stretch\}/);
  assert.match(css,/\.medsi-child-deck-detail-row\{display:grid;grid-template-columns:27px minmax\(0,1fr\);gap:10px;width:100%;align-items:center\}/);
  assert.match(css,/#medsiNamesPane \{row-gap:9px\}/);
  assert.match(css,/\.medsi-name-word\{padding:7px 9px;font-size:14px\}/);
});

test('mobile child profile uses a square card and bottom corner arrows without changing desktop',()=>{
  const css=read('tutors/next-settings.css');
  assert.match(css,/@media\(max-width:650px\)/);
  assert.match(css,/aspect-ratio:1 \/ 1;min-height:320px/);
  assert.match(css,/\.medsi-child-nav-arrow\{position:absolute;bottom:18px;left:18px;width:43px;height:43px\}/);
  assert.match(css,/\.medsi-child-nav-next\{left:auto;right:18px\}/);
  assert.match(css,/\.medsi-child-deck-identity\{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;gap:18px\}/);
  assert.match(css,/\.medsi-child-deck-nav \{\s*display:grid;grid-template-columns:48px/);
});
