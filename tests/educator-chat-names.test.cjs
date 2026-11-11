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
    replaceChildren(...items){this.children=[...items]},
    addEventListener(){},
    setAttribute(){},
  };
}
const displayPhone=v=>'8'+String(v||'').replace(/\D/g,'').slice(-10);
test('chat metadata abbreviates only the repeated lines, preserving full heading',()=>{
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
    'Родитель: Тамара\nРебёнок: Аня\nНомер телефона: 89000000001');
  assert.equal(card.children[3].textContent,'Последнее сообщение');
  assert.equal(card.dataset.phone,'9000000001');
});

test('open thread shows the same short labels and keeps telephone intact',()=>{
  const shortName=getShortName(main);
  const from=main.indexOf('    function renderThreadHeader(chat){');
  const to=main.indexOf('\n',from);
  assert.ok(from>=0&&to>from);
  const wrapper=makeElement('div');
  const fn=new Function('chatThreadHeader','document','shortName','displayPhone',
    main.slice(from,to)+'\nreturn renderThreadHeader;')(
      wrapper,{createElement:makeElement},shortName,displayPhone);
  fn({childName:'Аня Иванова',parentName:'Тамара Петрова',phone:'9000000001'});
  assert.deepEqual(wrapper.children.map(c=>c.textContent),[
    'Родитель: Тамара','Ребёнок: Аня','Номер телефона: 89000000001']);
  assert.match(main,/author\.textContent=m\.side==='parent'[\s\S]*?shortName\(activeChat\.parentName\)/);
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
    'Родитель: Алина\nРебёнок: Мишель\nНомер телефона: 89000000002');
});

test('educator chat scripts have fresh cache keys, unrelated identity API remains intact',()=>{
  assert.match(html,/educator-chat\.js\?v=20261111-short-labels-1/);
  assert.match(html,/educator-new-chat\.js\?v=20261111-short-labels-1/);
  const backend=read('services/postgres-next/app/chat-operations.mjs');
  assert.match(backend,/childName:\[child\.registered_first_name,child\.surname\]/);
  assert.match(backend,/parentName:profile\.parent_name/);
});