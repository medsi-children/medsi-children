import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalCurrentName,currentStaffPublications,parseCurrentStaffBlocks,
  matchRegisteredChild,matchCurrentSource,shortestCurrentSurnamePrefixes,
  isCurrentRoomNumberLine,stripCurrentRoomNumberLines,normalizeCurrentStaffHeaderLine
} from '../app/current-child-identity.mjs';
import {currentHeadStaffSources} from '../app/current-report-backfill.mjs';

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

test('evening explicit namesakes supersede morning bare name for NEW registrations',()=>{
  const publications=[
    src('Саша — Ранее без уточнения.', 'morning', '2026-11-09',100),
    src('Саша Ив. — Девочка читала.\nСаша Иг. — Девочка рисовала.',
      'evening','2026-11-09',200)
  ];
  assert.equal(check('Александра Игнатьева',publications).status,'new');
  assert.equal(check('Александра Иванова',publications).status,'new');
  assert.equal(check('Саша',publications).status,'ambiguous');
});

test('current source recovery keeps yesterday evening alongside today morning',()=>{
  const at=Date.parse('2026-11-24T10:30:00Z'); // 13:30 Moscow
  const records=[
    {kind:'morning',report_date:'2026-11-24',submitted_at:Date.parse('2026-11-24T08:00:00Z'),publication_id:'head_m'},
    {kind:'evening',report_date:'2026-11-23',submitted_at:Date.parse('2026-11-23T19:30:00Z'),publication_id:'head_e'},
    {kind:'psychology',report_date:'2026-11-23',submitted_at:Date.parse('2026-11-23T19:30:00Z'),publication_id:'therapy'},
    {kind:'morning',report_date:'2026-11-22',submitted_at:Date.parse('2026-11-22T09:00:00Z'),publication_id:'stale'}
  ];
  assert.deepEqual(currentHeadStaffSources(records).map(x=>x.publication_id),['head_m','head_e']);
});
test('historical current head can still be read after registration a week later',()=>{
  const at=Date.parse('2026-11-24T10:30:00Z');
  const previous={kind:'morning',report_date:'2026-11-15',
    submitted_at:Date.parse('2026-11-15T08:00:00Z'),publication_id:'historical_head'};
  assert.deepEqual(currentHeadStaffSources([previous],at),[previous]);
  assert.deepEqual(currentHeadStaffSources([{...previous,kind:'psychology'}]),[]);
  assert.deepEqual(currentHeadStaffSources([previous,{
    ...previous,publication_id:'new_head',submitted_at:previous.submitted_at+5000
  }]).map(x=>x.publication_id),['new_head']);
});

test('only standalone ward numbers 501–512 are excluded from parsed child blocks',()=>{
  for(let n=501;n<=512;n++){
    assert.equal(isCurrentRoomNumberLine(String(n)),true);
    assert.equal(isCurrentRoomNumberLine('Палата №'+n),true);
    assert.equal(isCurrentRoomNumberLine('пал. '+n+'.'),true);
    assert.equal(isCurrentRoomNumberLine('  № '+n+'  '),true);
    assert.equal(isCurrentRoomNumberLine('В палате '+n+' играл'),false);
    assert.equal(isCurrentRoomNumberLine(n+' деталей конструктора'),false);
  }
  for(const notRoom of ['500','513','1503','503–504','503-504',
    'Палата 513','Упражнение 503','503 – играл','24.11.2026']){
    assert.equal(isCurrentRoomNumberLine(notRoom),false,notRoom);
  }
  const text='501\nСаша Ив. — Играла в палате 503 с игрушками.\n'+
    '503\nСаша Иг. — Собрала 503 детали.\n512';
  assert.equal(stripCurrentRoomNumberLines(text),
    'Саша Ив. — Играла в палате 503 с игрушками.\nСаша Иг. — Собрала 503 детали.');
  for(const stored of [false,true]){
    const b=parseCurrentStaffBlocks(text,aliases,{stored});
    assert.deepEqual(b.map(x=>x.lineIndex),[1,3],
      'Filtering room numbers must not shift original heading indexes');
    assert.deepEqual(b.map(x=>x.body.join('\n')),[
      'Играла в палате 503 с игрушками.','Собрала 503 детали.'
    ]);
  }
});


test('strict age-style headings become safe block boundaries without altering source facts',()=>{
  const source='Степан С.: Вчера отдыхал.\n'+
    '❗️Мария Г., 12 лет. Синтетический комментарий о настроении.\n'+
    'Александра Иг.: Рисовала.';
  const parsed=parseCurrentStaffBlocks(source);
  assert.deepEqual(parsed.map(b=>b.name),['Степан','Мария','Александра']);
  assert.equal(parsed[1].prefix,'г');
  assert.deepEqual(parsed[1].body,['12 лет. Синтетический комментарий о настроении.']);
  assert.deepEqual(parsed[0].body,['Вчера отдыхал.']);
  assert.equal(normalizeCurrentStaffHeaderLine('❗️Мария Г., 12 лет. Наблюдение.'),
    'Мария Г.: 12 лет. Наблюдение.');
  for(const arbitrary of ['Мария сказала, что ей 12 лет.','Мария Г., 12 лет',
    'Мария Г., 12 лет, сказала о самочувствии.','Мария Г., 20 лет. Пример.',
    'Мария Г.: 12 лет. Текст.']){
    const normalized=normalizeCurrentStaffHeaderLine(arbitrary);
    if(arbitrary.includes('20 лет')||arbitrary.includes('сказала')||arbitrary.endsWith('12 лет'))
      assert.equal(normalized,arbitrary,'Uncertain age prose cannot become a header');
  }
});
