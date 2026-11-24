import test from 'node:test';
import assert from 'node:assert/strict';
import {displayCurrentStaffSource as display} from '../app/current-educator-source-display.mjs';
import {assembleCurrentEducatorDashboard} from '../app/current-educator-dashboard.mjs';
import {formatCurrentParentChildReport} from '../app/current-report-punctuation.mjs';
const children=[
  {child_id:'kid_one',registered_first_name:'Александра',surname:'Иванова'},
  {child_id:'kid_two',registered_first_name:'Александра',surname:'Игнатьева'}
];
const profiles=[{child_id:'kid_one'},{child_id:'kid_two'}];
const nameVariants=[{preferred_name:'Александра',variants_json:'["Саша"]'}];
const owner=(i,childId)=>({owner_key:'CURRENT_BLOCK_test_123_'+i,
  record_json:JSON.stringify({childId,blocked:false})});
test('only published owner gets retrospectively expanded surname letters',()=>{
  const raw='Саша И. — Читала книгу.\nСаша Иг. — Другое наблюдение.';
  const r=display({rawText:raw,children,profiles,nameVariants,
    ownerRecords:[owner(0,'kid_one'),owner(1,'kid_two')]});
  assert.match(r,/^Александра Ив — Читала книгу\./);
  assert.match(r,/\nАлександра Иг — Другое наблюдение\.$/);
  assert.equal(raw,'Саша И. — Читала книгу.\nСаша Иг. — Другое наблюдение.');
});
test('unowned and quarantined old blocks are not relabeled by today’s namesake',()=>{
  const raw='Саша И. — Старый текст.';
  assert.equal(display({rawText:raw,children,profiles,nameVariants,ownerRecords:[]}),raw);
  assert.equal(display({rawText:raw,children,profiles,nameVariants,
    ownerRecords:[{owner_key:'CURRENT_BLOCK_test_123_0',record_json:'{"blocked":true}'}]}),raw);
});
test('general section does not shift owner line-index mapping',()=>{
  const raw='Общий комментарий: Сегодня спокойно.\nСаша И. — Читала книгу.';
  const r=display({rawText:raw,children,profiles,nameVariants,
    ownerRecords:[owner(0,'kid_one')]});
  assert.equal(r,'Общий комментарий: Сегодня спокойно.\nАлександра Ив — Читала книгу.');
});
test('no rewrite when saved owner no longer has registered parent',()=>{
  const raw='Саша И. — Старый текст.';
  assert.equal(display({rawText:raw,children,profiles:[{child_id:'kid_two'}],
    nameVariants,ownerRecords:[owner(0,'kid_one')]}),raw);
});

test('old source preview drops isolated room numbers without shifting publication ownership',()=>{
 const source='501\nСаша И. — Была в палате 503.\n503\n'+
   'Саша Иг. — Создала 503 рисунка.\nПалата №512';
 const shown=display({rawText:source,children,profiles,nameVariants,
   ownerRecords:[owner(0,'kid_one'),owner(1,'kid_two')]});
 assert.equal(shown,
   'Александра Ив — Была в палате 503.\n'+
   'Александра Иг — Создала 503 рисунка.');
 assert.match(source,/^501\n/,'The original source stays immutable');
});

test('already published room labels disappear from both educator preview and parent text',()=>{
 const source='501\nСаша И. — В палате 503 читала.\n503\n'+
   'Саша Иг. — Нарисовала 503 фигурки.\n512';
 const dashboard=assembleCurrentEducatorDashboard({
  profiles:[{phone10:'9000000001',child_id:'kid_one',parent_name:'Мама Тест'},
            {phone10:'9000000002',child_id:'kid_two',parent_name:'Папа Тест'}],
  children,heads:[{kind:'morning',publication_id:'synthetic_pub'}],
  rawByPublication:new Map([['synthetic_pub',{
    report_date:'2026-11-24',raw_text:source,normalized_text:source
  }]]),
  ownerByPublication:new Map([['synthetic_pub',[owner(0,'kid_one'),owner(1,'kid_two')]]]),
  current:[{
    phone10:'9000000001',child_id:'kid_one',kind:'morning',publication_id:'synthetic_pub',
    text:'Александра: Читала.\n503\nПотом играла в палате 503.'
  }],
  nameVariants
 });
 assert.equal(dashboard.raw.morning.rawText,source);
 assert.doesNotMatch(dashboard.raw.morning.displayText,/(^|\n)(501|503|512)(?=\n|$)/);
 assert.doesNotMatch(dashboard.raw.morning.normalizedText,/(^|\n)(501|503|512)(?=\n|$)/);
 const first=dashboard.children.find(c=>c.childId==='kid_one');
 assert.equal(first.parentViews[0].reports.morning,
  'Александра: Читала.\nПотом играла в палате 503.');
 assert.equal(formatCurrentParentChildReport('Александра: Читала.\n503\nИграла в палате 503.'),
  'Александра: Читала.\nИграла в палате 503.');
});
