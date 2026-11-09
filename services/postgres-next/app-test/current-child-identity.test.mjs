import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalCurrentName,currentStaffPublications,parseCurrentStaffBlocks,
  matchRegisteredChild,matchCurrentSource,shortestCurrentSurnamePrefixes
} from '../app/current-child-identity.mjs';

const aliases=[
  {preferred_name:'Александра',variants_json:'["Саша","Шура"]'},
  {preferred_name:'Степан',variants_json:'["Стёпа","Степа"]'}
];
const src=(text,kind='morning',date='2026-11-09',submitted_at=100)=>({
  kind,report_date:date,submitted_at,normalized_text:text,publication_id:kind+'_'+submitted_at
});
const check=(childName,publications,more={})=>
  matchCurrentSource({childName,publications,nameVariants:aliases,today:'2026-11-09',...more});
test('staff source independently contains children whose parents never signed up',()=>{
  const result=parseCurrentStaffBlocks('Степан: Спокойно играл.\nСаша Ив. — Читала книгу.\nМиша: Смотрел фильм.',aliases);
  assert.deepEqual(result.map(x=>x.canonical),['степан','александра','миша']);
  assert.deepEqual(result.map(x=>x.prefix),['','ив','']);
});
test('late registration links the ONLY current Stepan, ignoring unregistered stale child rows',()=>{
  const ghost={child_id:'child_old',registered_first_name:'Степан',surname:'Мерцалов'};
  const selected=check('Степан Сидоров',[src('Степан — Сегодня участвовал в игре.')],
    {profiles:[],children:[ghost]});
  assert.equal(selected.status,'new');
  assert.equal(selected.firstName,'Степан');
  assert.equal(selected.surname,'Сидоров');
});
test('current parent matches existing current child without using hospital record',()=>{
  const child={child_id:'child_123',registered_first_name:'Степан',surname:'Сидоров'};
  assert.deepEqual(matchRegisteredChild({childName:'Стёпа Сидоров',
    children:[child],profiles:[{phone10:'9000000001',child_id:child.child_id}],nameVariants:aliases}),
    {childId:'child_123',kind:'registered'});
});
test('two parents share same child but a conflicting surname never attaches to it',()=>{
  const child={child_id:'child_123',registered_first_name:'Степан',surname:'Сидоров'};
  const profiles=[{phone10:'9000000001',child_id:child.child_id}];
  assert.equal(matchRegisteredChild({childName:'Степан Мерцалов',children:[child],profiles,nameVariants:aliases}),null);
  assert.equal(check('Степан Мерцалов',[src('Степан — Занимался.')],
    {children:[child],profiles}).status,'ambiguous');
});
test('early registration waits for staff report, never finds patients from old reports',()=>{
  assert.equal(check('Степан Сидоров',[]).status,'pending');
  assert.equal(check('Степан Сидоров',[src('Степан — Старый текст.','morning','2026-11-08')]).status,'pending');
  assert.equal(check('Степан Сидоров',[src('Степан — Свежее наблюдение.')]).status,'new');
});
test('two different same-name initials remain distinguishable by two letters',()=>{
  const current=src('Саша Ив. — Сегодня читала.\nСаша Иг. — Сегодня рисовала.');
  const a=check('Александра Иванова',[current]);
  const b=check('Саша Игнатьева',[current]);
  assert.equal(a.status,'new');
  assert.equal(b.status,'new');
  assert.equal(check('Саша',[current]).status,'ambiguous');
});
test('two identical initials must never distribute to either parent',()=>{
  const current=src('Саша И. — Один текст.\nСаша И. — Другой текст.');
  assert.equal(check('Александра Иванова',[current]).status,'ambiguous');
  assert.equal(check('Саша Игнатьева',[current]).status,'ambiguous');
});
test('a bare namesake is ambiguous when an existing registered child competes',()=>{
  const children=[{child_id:'child_ivanova',registered_first_name:'Александра',surname:'Иванова'}];
  const profiles=[{phone10:'9000000001',child_id:'child_ivanova'}];
  assert.equal(check('Саша Игнатьева',[src('Саша — Неподписанный блок.')],{children,profiles}).status,'ambiguous');
});
test('nickname overlaps are never silently assigned to a preferred group',()=>{
  const conflict=[...aliases,{preferred_name:'Александр',variants_json:'["Саша"]'}];
  assert.equal(canonicalCurrentName('Саша',conflict),null);
  assert.equal(check('Саша Иванова',[src('Саша — Блок.')],{nameVariants:conflict}).status,'invalid');
});
test('select last submitted source of each kind for single latest date',()=>{
  assert.deepEqual(currentStaffPublications([
    src('Степан М. — Старый.','morning','2026-11-08',100),
    src('Степан — Старый вечер.','evening','2026-11-08',150),
    src('Степан — Сегодня.','morning','2026-11-09',200),
    src('Степан — Сегодня поправка.','morning','2026-11-09',220),
    src('Степан — Сегодня вечер.','evening','2026-11-09',230)
  ],'2026-11-09').map(x=>x.submitted_at),[220,230]);
});
test('prefix expands just as far as needed and never mutates authors text',()=>{
  const children=[
    {child_id:'one',registered_first_name:'Александра',surname:'Иванова'},
    {child_id:'two',registered_first_name:'Александра',surname:'Игнатьева'},
    {child_id:'three',registered_first_name:'Степан',surname:'Сидоров'}
  ];
  const names=shortestCurrentSurnamePrefixes(children,aliases);
  assert.equal(names.get('one'),'Ив');
  assert.equal(names.get('two'),'Иг');
  assert.equal(names.get('three'),'С.');
});
test('duplicate parent profiles are not mistaken for two different children',()=>{
  const children=[{child_id:'kid1',registered_first_name:'Степан',surname:'Сидоров'}];
  const profiles=[{child_id:'kid1',phone10:'9000000001'}, {child_id:'kid1',phone10:'9000000002'}];
  assert.equal(matchRegisteredChild({childName:'Степан',children,profiles}).childId,'kid1');
});
