import test from 'node:test';
import assert from 'node:assert/strict';
import {displayCurrentStaffSource as display} from '../app/current-educator-source-display.mjs';
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
