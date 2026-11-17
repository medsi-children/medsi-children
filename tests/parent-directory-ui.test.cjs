const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=filepath=>fs.readFileSync(path.join(__dirname,'..',filepath),'utf8');

test('sixth educator tile opens private archive with search and independent deletion',()=>{
  const html=read('tutors.html');
  const settings=read('tutors/next-settings.js');
  const screen=read('tutors/parent-directory.js');
  const styles=read('tutors/parent-directory.css');
  assert.match(html,/\/tutors\/parent-directory\.js\?v=20261117-clean-cards-1/);
  assert.match(html,/\/tutors\/parent-directory\.css\?v=20261117-clean-cards-1/);
  assert.match(html,/next-settings\.js\?v=20261117-parent-directory-1/);
  assert.equal((settings.match(/class="medsi-setting-tile/g)||[]).length,6);
  assert.match(settings,/id="medsiParentDirectoryCard"/);
  assert.match(settings,/База родителей/);
  assert.doesNotMatch(settings,/id="medsiQrCard"|id="medsiPushTestCard"/);
  assert.match(screen,/medsiDirectorySearch/);
  assert.match(screen,/parent-directory\/\+'\+encodeURIComponent\(row\.entryId\)/);
  assert.match(screen,/method:'DELETE'/);
  assert.match(screen,/if\(!window\.confirm\('Удалить эту запись только/);
  assert.match(screen,/id="medsiDirectoryImport"/);
  assert.match(screen,/Требуется вход|Сначала войдите/);
  assert.match(screen,/sourceRow:i\+2/);
  assert.doesNotMatch(screen,/localStorage|sessionStorage/);
  assert.match(styles,/\.medsi-directory-overlay/);
  assert.match(styles,/@media\(max-width:560px\)/);
});

test('directory contact cards contain no dates, sources, or delete text buttons',()=>{
  const screen=read('tutors/parent-directory.js');
  const css=read('tutors/parent-directory.css');
  const backend=read('services/postgres-next/app/parent-directory.mjs');
  const registration=read('services/postgres-next/app/current-parent-registration.mjs');
  const schema=read('services/postgres-next/app/current-child-schema.mjs');
  assert.match(screen,/info\.append\(title,parent,phone\)/);
  assert.doesNotMatch(screen,/registeredAt|toLocaleDateString|medsi-directory-source|origin\.textContent/);
  assert.doesNotMatch(screen,/remove\.textContent='Удалить'/);
  assert.match(screen,/remove\.innerHTML='<svg/);
  assert.match(screen,/remove\.setAttribute\('aria-label','Удалить запись из базы родителей'\)/);
  assert.match(screen,/window\.confirm\('Удалить эту запись только/);
  assert.match(css,/\.medsi-directory-remove\{[^}]*width:36px/);
  assert.doesNotMatch(css,/\.medsi-directory-source\{/);
  assert.doesNotMatch(backend,/registeredAt:row\.registered_at|source:row\.source/);
  assert.match(registration,/\$\{''\},\$\{'registration'\},\$\{null\},\$\{at\}/);
  assert.match(schema,/\$\{'current_profile'\}, \$\{null\},/);
});
