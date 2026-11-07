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
  assert.match(html,/next-settings\.css\?v=20261107-child-name-sizing-17/);
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

test('mobile names stay readable and compact',()=>{
  const css=read('tutors/next-settings.css');
  assert.match(css,/#medsiNamesPane \{row-gap:9px\}/);
  assert.match(css,/\.medsi-name-word\{padding:7px 9px;font-size:14px\}/);
});

test('mobile child profile matches the landscape reference with side arrows and tinted data rows',()=>{
  const css=read('tutors/next-settings.css'),js=read('tutors/next-settings.js');
  assert.match(css,/@media\(max-width:650px\)/);
  const mobile=css.slice(css.indexOf('@media(max-width:650px)'));
  assert.match(mobile,/\.medsi-child-deck-nav\{\s*display:grid;grid-template-columns:34px minmax\(0,1fr\) 34px/);
  assert.match(mobile,/justify-self:stretch;width:100%;aspect-ratio:auto/);
  assert.match(mobile,/\.medsi-child-nav-arrow\{position:relative;inset:auto;width:34px;height:34px/);
  assert.match(mobile,/\.medsi-child-deck-identity\{\s*display:grid;grid-template-columns:minmax\(0,.95fr\) minmax\(0,1.5fr\)/);
  assert.match(mobile,/\.medsi-child-deck-name\{\s*width:auto;min-width:0;border:0;padding:0;text-align:left/);
  assert.match(mobile,/\.medsi-child-deck-name h3\{font-size:clamp\(15px,4vw,18px\)/);
  assert.match(mobile,/\.medsi-child-deck-identity\{gap:5px;grid-template-columns:minmax\(0,.9fr\) minmax\(0,1.5fr\)\}/);
  assert.match(mobile,/\.medsi-child-deck-detail-row\{\s*display:grid;grid-template-columns:25px minmax\(0,1fr\)/);
  assert.match(mobile,/border-radius:999px;background:#eef8fa/);
  assert.match(mobile,/@media\(max-width:355px\)/);
  assert.doesNotMatch(mobile,/width:min\(100%,224px\)/);
  // DOM structure and pagination are unchanged; reports and all parent rows still render.
  assert.match(js,/navigation\.append\(previous,identity,next\)/);
  assert.match(js,/for\(const parent of linkedParents\)/);
  assert.match(js,/detailRow\('phone','',parent\.phone\)/);
  assert.match(js,/pane\.append\(textNode\('p','medsi-child-deck-progress'/);
  // Desktop stays on its own horizontal grid, without mobile pill styling.
  assert.match(css,/\.medsi-child-deck-nav \{\s*display:grid;grid-template-columns:48px/);
});
