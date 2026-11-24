const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=pathName=>fs.readFileSync(path.join(__dirname,'..',pathName),'utf8');
const main=read('chat-overlay/educator-chat.js');
const picker=read('chat-overlay/educator-new-chat.js');
const html=read('tutors.html');

function getShortName(source){
  const start=source.indexOf('  const shortName=');
  assert.ok(start>=0,'Chat detail first-name helper is present');
  const line=source.slice(start,source.indexOf('\n',start));
  return new Function(line+'\nreturn shortName;')();
}
function makeElement(tag){
  return {tag,children:[],textContent:'',dataset:{},style:{},
    append(...items){this.children.push(...items)},
    appendChild(item){this.children.push(item);return item},
    replaceChildren(...items){this.children=[...items]},
    addEventListener(){},
    setAttribute(){},
  };
}
const displayPhone=v=>'+7'+String(v||'').replace(/\D/g,'').slice(-10);
test('chat metadata keeps child heading, relationship and one phone line',()=>{
  const shortName=getShortName(main);
  for(const [value,expected] of [
    ['Аня Иванова','Аня'],['Тамара Петрова','Тамара'],
    ['Анна-Мария Соколова','Анна-Мария'],
    ['Мишель Смирнова','Мишель'],[' Аня   Иванова ','Аня'],
    ['', '—'],['   ', '—']
  ])assert.equal(shortName(value),expected);
  const start=main.indexOf('    function makeCard(chat){');
  const end=main.indexOf('    function renderList(){',start);
  assert.ok(start>=0&&end>start);
  const makeCard=new Function('document','makeControls','shortName','displayPhone',
    'preview','openThread','activeChat',
    main.slice(start,end)+'\nreturn makeCard;')(
      {createElement:makeElement},
      ()=>makeElement('div'),shortName,displayPhone,()=> 'Последнее сообщение',()=>{},null);
  const card=makeCard({childName:'Аня Иванова',parentName:'Тамара Петрова',
    relationship:'Мама',phone:'9000000001',lastType:'text'});
  assert.equal(card.children[1].textContent,'Аня Иванова');
  assert.equal(card.children[2].textContent,
    'Мама Тамара\nТелефон: +79000000001');
  assert.equal(card.children[3].textContent,'Последнее сообщение');
  assert.equal(card.dataset.phone,'9000000001');
});

test('open thread shows the same three-line child-first identity',()=>{
  const shortName=getShortName(main);
  const from=main.indexOf('    function renderThreadHeader(chat){');
  const to=main.indexOf('    function threadWithTimeout(',from);
  assert.ok(from>=0&&to>from);
  const wrapper=makeElement('div');
  const fn=new Function('chatThreadHeader','document','shortName','displayPhone','phone10',
    main.slice(from,to)+'\nreturn renderThreadHeader;')(
      wrapper,{createElement:makeElement},shortName,displayPhone,v=>String(v||'').replace(/\\D/g,'').slice(-10));
  fn({childName:'Аня Иванова',parentName:'Тамара Петрова',relationship:'Мама',phone:'9000000001'});
  assert.deepEqual(wrapper.children[0].children.map(c=>c.textContent),[
    'Аня Иванова','Мама Тамара','Телефон: +79000000001']);
  assert.equal(wrapper.children.length,1);
  assert.equal(wrapper.children[0].className,'chat-identity-details');
  assert.match(main,/author\.textContent=m\.side==='parent'[\s\S]*?activeChat\?\.relationship[\s\S]*?shortName\(activeChat\?\.parentName\)/);
});

test('new chat picker uses the same parent/child detail labels',()=>{
  const shortName=getShortName(picker);
  const start=picker.indexOf('    function render(rows){');
  const end=picker.indexOf('    async function loadParents()',start);
  assert.ok(start>=0&&end>start);
  const list=makeElement('div');
  const render=new Function('document','list','rowsSignature','displayPhone',
    'shortName','bridgeToCard','renderedSignature',
    picker.slice(start,end)+'\nreturn render;')(
      {createElement:makeElement},list,()=>'',displayPhone,shortName,()=>{},'');
  render([{childName:'Мишель Морозова',parentName:'Алина Климова',
    relationship:'Мама',phone:'9000000002'}]);
  assert.equal(list.children.length,1);
  const card=list.children[0];
  assert.equal(card.children[0].textContent,'Мишель Морозова');
  assert.equal(card.children[1].textContent,
    'Мама Алина\nТелефон: +79000000002');
});

test('educator chat scripts have fresh cache keys, unrelated identity API remains intact',()=>{
  assert.match(html,/educator-chat\.js\?v=20261124-role-label-1/);
  assert.match(html,/educator-new-chat\.js\?v=20261111-short-labels-1/);
  const backend=read('services/postgres-next/app/chat-operations.mjs');
  assert.match(backend,/childName:\[child\.registered_first_name,child\.surname\]/);
  assert.match(backend,/parentName:profile\.parent_name/);
});
test('opened chat identity stays compact on mobile while preserving child-first hierarchy',()=>{
  const css=read('chat-overlay/educator-exact.css');
  const html=read('tutors.html');
  assert.match(css,/#screenChatThread #chatThreadHeader\.chat-info\{/);
  assert.match(css,/#screenChatThread #chatThreadHeader \.chat-identity-title\{\s*font-size:\.95rem;/);
  assert.match(css,/#screenChatThread #chatThreadHeader \.chat-identity-parent\{\s*font-size:\.82rem;/);
  assert.match(css,/#screenChatThread #chatThreadHeader \.chat-identity-phone\{\s*font-size:\.77rem;/);
  assert.match(css, /@media\(max-width:560px\)/);
  assert.match(html,/educator-exact\.css\?v=20261117-reply-excerpt-1/);
  assert.match(main,/chatThreadHeader\.append\(details\)/);
  const composer=read('chat-overlay/composer-ui.js');
  assert.match(composer,/\(\?:Номер телефона\|Телефон\)/);
  assert.match(composer,/tel:\+7/);
  assert.match(html,/composer-ui\.js\?v=20261117-phone-label-1/);
});

test('quoted replies finish on complete words and show ellipsis, including long mobile replies',()=>{
  const start=main.indexOf('function replyLabel(r){');
  const end=main.indexOf('function mediaUrl(m){',start);
  assert.ok(start>=0&&end>start);
  const replyLabel=new Function(main.slice(start,end)+'return replyLabel;')();
  const source=('Здравствуйте! Прошу передать Еве. Сейчас у мамы очень много работы, '+
    'допоздна сижу с документами. Поэтому до выписки вряд ли получится приехать. '+
    'Очень скучаем, увидимся в пятницу.');
  const excerpt=replyLabel({type:'text',text:source});
  assert.ok(excerpt.length<source.length);
  assert.ok(excerpt.endsWith('…'));
  assert.ok(source.includes(excerpt.slice(0,-1)+' '),
    'excerpt may only end at a whole-word boundary');
  assert.equal(replyLabel({type:'image'}),'Фотография');
  assert.equal(replyLabel({type:'video'}),'Видео');
  const css=read('chat-overlay/educator-exact.css');
  assert.match(css,/#screenChatThread \.msg-reply-quote\{/);
  assert.match(css,/-webkit-line-clamp:4/);
  assert.match(css,/font-size:\.85rem/);
  assert.match(css,/word-break:normal/);
  assert.match(html,/educator-chat\.js\?v=20261124-role-label-1/);
  assert.match(html,/educator-exact\.css\?v=20261117-reply-excerpt-1/);
});

test('author of every parent message uses exactly the same role and first name as chat header',()=>{
  const shortName=getShortName(main);
  const from=main.indexOf('    function renderThreadHeader(chat){');
  const to=main.indexOf('    function threadWithTimeout(',from);
  assert.ok(from>=0&&to>from);
  const makeHeader=new Function('chatThreadHeader','document','shortName','displayPhone',
    main.slice(from,to)+'\nreturn renderThreadHeader;');
  const start=main.indexOf("      author.textContent=m.side==='parent'",main.indexOf('    function messageNode('));
  const end=main.indexOf('      el.appendChild(author);',start);
  assert.ok(start>=0&&end>start,'Message author expression remains available');
  const renderAuthor=new Function('m','activeChat','shortName',
    'const author={textContent:""};\n'+main.slice(start,end)+'\nreturn author.textContent;');
  for(const [chat,expected] of [
    [{childName:'Синтетический ребёнок',parentName:'Ирина Тестовая',relationship:'Мама',phone:'9000000001'},'Мама Ирина'],
    [{childName:'Синтетический ребёнок',parentName:'Алексей Тестовый',relationship:'Папа',phone:'9000000002'},'Папа Алексей'],
    [{childName:'Синтетический ребёнок',parentName:'Александр Тестовый',relationship:'Родитель',phone:'9000000003'},'Родитель Александр'],
    [{childName:'Синтетический ребёнок',parentName:'Мария Тестовая',phone:'9000000004'},'Родитель Мария']
  ]){
    const container=makeElement('div');
    makeHeader(container,{createElement:makeElement},shortName,displayPhone)(chat);
    const label=container.children[0].children[1].textContent;
    assert.equal(label,expected);
    assert.equal(renderAuthor({side:'parent'},chat,shortName),label,
      'Existing and new parent messages must match the header role exactly');
    assert.equal(renderAuthor({side:'educator'},chat,shortName),'Детское Отделение Медси');
  }
});
