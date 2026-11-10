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
  assert.match(html,/next-settings\.css\?v=20261110-roster-unified-1/);
  assert.match(html,/next-settings\.js\?v=20261110-name-clarify-1/);
  assert.doesNotMatch(js,/Выбрать ребёнка по сырому отчёту|Очистить удалённых детей/);
  assert.doesNotMatch(js,/Старая привязка — нужна проверка/);
  assert.match(js,/Нужна проверка привязки/);
  assert.doesNotMatch(js,/Родитель есть в боте/);
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


test('raw morning and evening reports visually separate child blocks but keep one original editor',()=>{
  const js=read('tutors/next-settings.js');
  const css=read('tutors/next-settings.css');
  const start=js.indexOf('  function splitSourceChildBlocks(value){');
  const end=js.indexOf('  function renderSourceChildPreview(target,value){',start);
  assert.ok(start>=0&&end>start,'The raw source preview must use a pure text segmenter');
  const segment=new Function(js.slice(start,end)+';return splitSourceChildBlocks;')();
  const text=[
    'Арина Ал — Поделилась переживаниями.',
    'Михаил К. — Участвовал в занятии.',
    'Продолжение наблюдения.',
    'Общий комментарий: Пункты для врачей.'
  ].join('\n');
  const parts=segment(text);
  assert.equal(parts.length,2);
  assert.equal(parts[0].name,'Арина Ал');
  assert.equal(parts[0].content,'Поделилась переживаниями.');
  assert.equal(parts[1].name,'Михаил К.');
  assert.match(parts[1].content,/Продолжение наблюдения/);
  assert.match(parts[1].content,/Общий комментарий/);
  assert.deepEqual(segment('Только текст, без детских блоков.'),
    [{type:'plain',content:'Только текст, без детских блоков.'}]);
  assert.match(js,/sourceKind==='morning'\|\|sourceKind==='evening'/);
  assert.match(js,/area\.value=originalSource\|\|''/);
  assert.match(js,/clarifier\.prepare\(\{kind,text,publicationId:/);
  assert.match(js,/entry\.rawText\|\|entry\.normalizedText/);
  assert.match(css,/\.medsi-source-child-block\{/);
  assert.match(css,/\.medsi-source-child-name\{font-weight:800/);
  assert.match(css,/\.medsi-raw-morning \.medsi-source-child-block/);
  assert.match(css,/\.medsi-raw-evening \.medsi-source-child-block/);
});


test('unlinked parent can be deleted without manual child assignment',async()=>{
  const source=read('tutors/next-settings.js');
  const begin=source.indexOf('function renderRoster(data){');
  const end=source.indexOf('  async function refreshRoster(){',begin);
  assert.ok(begin>=0&&end>begin,'Directory renderer must remain extractable');
  const pane={tag:'div',className:'',children:[],replaceChildren(...items){this.children=[...items]},append(...items){this.children.push(...items)}};
  const node=(tag,className='',value='')=>({
    tag,className,textContent:String(value??''),children:[],dataset:{},
    append(...items){this.children.push(...items)},
    replaceChildren(...items){this.children=[...items]},
    setAttribute(){},
    classList:{add(){},remove(){},contains(){return false}}
  });
  const requests=[],confirms=[],feedback={textContent:''};
  const render=new Function('byId','textNode','icon','deleteIcon','rosterEdit','request','refreshRoster',
    'refreshLibrary','window','setTimeout','document',
    source.slice(begin,end)+'\nreturn renderRoster;')(
      id=>id==='medsiReportsFeedback'?feedback:pane,node,()=>'<svg/>','',()=>{},
      (...args)=>{requests.push(args);return Promise.resolve({ok:true,accepted:true})},
      ()=>true,()=>{}, {confirm:message=>{confirms.push(message);return true}},()=>{},{createElement:tag=>({...node(tag),focus(){}})}
    );
  const unlinked={phone10:'9000000091',phone:'89000000091',parentName:'Тестовый родитель',
    childName:'Новый ребёнок',relationship:'Мама',linked:false,registered:true,assignable:[{childId:'child_synthetic',admissionId:'admission_synthetic',label:'Новый ребёнок'}]};
  render({children:[],unlinked:[unlinked]});
  assert.equal(pane.children.length,1);
  const card=pane.children[0];
  assert.equal(card.tag,'article');
  assert.match(card.className,/medsi-roster-line-unlinked/);
  const allText=JSON.stringify(card);
  assert.match(allText,/Новый ребёнок/);
  assert.match(allText,/Тестовый родитель/);
  assert.match(allText,/89000000091/);
  const actions=card.children.find(item=>item.className==='medsi-roster-line-actions');
  assert.ok(actions);
  assert.equal(actions.children.length,3);
  const [morning,evening,del]=actions.children;
  assert.equal(morning.dataset.present,'?');
  assert.equal(evening.dataset.present,'?');
  assert.equal(morning.dataset.tooltip,'Утреннего отчёта нет');
  assert.equal(evening.dataset.tooltip,'Вечернего отчёта нет');
  assert.match(del.className,/medsi-roster-line-delete/);
  await del.onclick();
  assert.equal(confirms[0],
    'Удалить ребёнка Новый ребёнок из бота?\nЧат с родителем исчезнет, доступ к боту закроется.');
  assert.equal(requests.length,1);assert.equal(requests[0][0],'/lab/parent-delete');
  assert.equal(requests[0][2].phone,unlinked.phone);
  assert.match(requests[0][2].operationId,/^del_/);
  assert.doesNotMatch(allText,/medsi-roster-assignment|Назначить ребёнка/);
  const css=read('tutors/next-settings.css');
  assert.match(css,/\.medsi-roster-line-unlinked\{/);

});

test('linked child remains in the shared directory and unlinked parents are appended last',()=>{
  const js=read('tutors/next-settings.js');
  assert.match(js,/const unlinked=Array\.isArray\(data\?\.unlinked\)/);
  assert.match(js,/if\(!children\.length&&!unlinked\.length&&!needsReview\.length\)/);
  assert.match(js,/for\(const child of children\)/);
  assert.match(js,/for\(const parent of unlinked\)/);
  assert.doesNotMatch(js,/section\.append\(textNode\('h3','medsi-roster-unlinked-heading'/);
  assert.match(js,/pane\.append\(card\)/);
  assert.match(js,/\/lab\/admin\/roster/);
});


test('unlinked directory omits redundant bot-presence status',()=>{
  const js=read('tutors/next-settings.js');
  assert.doesNotMatch(js,/parent\.assignable|kind:'assign'|Назначить ребёнка|Очистить удалённых детей/);
  assert.doesNotMatch(js,/Родителя нет в боте|Регистрация родителя не подтверждена/);
  assert.match(js,/Утреннего отчёта нет/);
  assert.match(js,/Вечернего отчёта нет/);

  assert.doesNotMatch(js,/В боте:|Чат:|Утренний: не определён|Вечерний: не определён|Привязка: нет/);
  assert.doesNotMatch(js,/Нет привязки к госпитализации'\)\)/);
});

test('linked children first, muted unlinked and review profiles last; multi-parent deletion remains per profile',async()=>{
  const source=read('tutors/next-settings.js');
  const begin=source.indexOf('function renderRoster(data){');
  const end=source.indexOf('  async function refreshRoster(){',begin);
  assert.ok(begin>=0&&end>begin);
  const pane={children:[],replaceChildren(...items){this.children=[...items]},append(...items){this.children.push(...items)}};
  const node=(tag,className='',value='')=>({
    tag,className,textContent:String(value??''),children:[],dataset:{},
    append(...items){this.children.push(...items)},
    replaceChildren(...items){this.children=[...items]},
    setAttribute(){},
    classList:{add(){},remove(){},contains(){return false}}
  });
  const requests=[],confirms=[],feedback={textContent:''};
  const render=new Function('byId','textNode','icon','deleteIcon','rosterEdit','request','refreshRoster',
    'refreshLibrary','window','setTimeout','document',
    source.slice(begin,end)+'\nreturn renderRoster;')(
    id=>id==='medsiReportsFeedback'?feedback:pane,node,()=>'<svg/>','',()=>{},
    (...args)=>{requests.push(args);return Promise.resolve({ok:true,accepted:true})},
    ()=>true,()=>{}, {confirm:message=>{confirms.push(message);return true}},()=>{},
    {createElement:tag=>({...node(tag),focus(){}})}
  );
  render({
    children:[{
      childId:'child_arina',admissionId:'child_arina',
      firstName:'Арина',surname:'Халитова',morning:true,evening:false,
      parents:[
        {phone10:'9000000001',phone:'89000000001',parentName:'Мама',relationship:'Мама'},
        {phone10:'9000000002',phone:'89000000002',parentName:'Папа',relationship:'Папа'}
      ]
    }],
    unlinked:[{
      phone10:'9000000003',phone:'89000000003',childName:'Артём Тестов',
      parentName:'Другой родитель',relationship:'Мама'
    }],
    review:[{
      phone10:'9000000004',phone:'89000000004',childName:'Тестовый профиль',
      parentName:'Родитель для проверки',relationship:'Папа'
    }]
  });
  assert.equal(pane.children.length,3,'all profiles should be peer rows without category sections');
  assert.match(pane.children[0].className,/medsi-roster-line/);
  assert.doesNotMatch(pane.children[0].className,/medsi-roster-line-unlinked/);
  assert.match(pane.children[1].className,/medsi-roster-line-unlinked/);
  assert.match(pane.children[2].className,/medsi-roster-line-unlinked/);
  assert.match(JSON.stringify(pane.children[0]),/Арина/);
  assert.match(JSON.stringify(pane.children[1]),/Артём Тестов/);
  assert.match(JSON.stringify(pane.children[2]),/Тестовый профиль/);
  const actions=pane.children[0].children.find(x=>x.className==='medsi-roster-line-actions');
  const del=actions.children.find(x=>x.className==='medsi-roster-line-delete');
  await del.onclick();
  assert.equal(confirms[0],
    'Удалить ребёнка Арина Халитова из бота?\nЧаты с родителями исчезнут, доступ к боту закроется.');
  assert.deepEqual(requests.map(x=>x[2].phone),['89000000001','89000000002']);
  assert.ok(requests.every(x=>x[0]==='/lab/parent-delete'));
  const css=read('tutors/next-settings.css');
  assert.match(css,/\.medsi-roster-line-unlinked\{[^}]*background:#f7f9fa/);
  assert.doesNotMatch(css,/\.medsi-roster-unlinked-heading/);
});

test('educator settings deletion uses the same short parent-access warning',()=>{
  const js=read('tutors/full-web.js');
  assert.match(js,/Чат с родителем исчезнет, доступ к боту закроется/);
  assert.doesNotMatch(js,/Вся история сообщений будет удалена/);
});
