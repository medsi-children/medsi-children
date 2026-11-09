import test from 'node:test';
import assert from 'node:assert/strict';
import {planCurrentReport,currentReportVersion} from '../app/current-report-plan.mjs';
const children=[
  {child_id:'kid_ivanova',registered_first_name:'Александра',surname:'Иванова'},
  {child_id:'kid_ignatieva',registered_first_name:'Александра',surname:'Игнатьева'},
  {child_id:'kid_stepan',registered_first_name:'Степан',surname:'Сидоров'}
];
const variants=[{preferred_name:'Александра',variants_json:'["Саша"]'}];
const parent=(phone10,child_id)=>({phone10,child_id});
const plan=(text,more={})=>planCurrentReport({
  kind:'morning',rawText:text,children,profiles:[
    parent('9000000001','kid_ivanova'),parent('9000000002','kid_ignatieva'),
    parent('9000000003','kid_stepan')
  ],nameVariants:variants,...more
});
test('explicit 2-letter initials distribute to correct parent without hospital ID',()=>{
  const r=plan('Саша Ив. — Читала книгу.\nСаша Иг. — Рисовала.\nСтепан — Собирал конструктор.');
  assert.deepEqual(r.recipients.map(x=>x.phone10),['9000000001','9000000002','9000000003']);
  assert.match(r.recipients[0].text,/Читала/);
  assert.doesNotMatch(r.recipients[0].text,/Рисовала/);
  assert.match(r.recipients[1].text,/Рисовала/);
  assert.match(r.recipients[2].text,/конструктор/);
});
test('one bare Sasha heading with two namesakes distributes to neither',()=>{
  const r=plan('Саша — Неясная запись.\nСтепан — Независимая запись.');
  assert.deepEqual(r.recipients.map(x=>x.phone10),['9000000003']);
  assert.equal(r.unresolved.length,1);
});
test('two Sasha И. headings both quarantined',()=>{
  const r=plan('Саша И. — Первый.\nСаша И. — Второй.');
  assert.equal(r.recipients.length,0);
  assert.equal(r.unresolved.length,2);
});
test('same child with two parents receives identical text',()=>{
  const r=plan('Степан: Играл.',{profiles:[parent('9000000003','kid_stepan'),parent('9000000004','kid_stepan')]});
  assert.equal(r.recipients.length,2);
  assert.equal(r.recipients[0].childId,'kid_stepan');
  assert.equal(r.recipients[0].text,r.recipients[1].text);
});
test('unregistered child never creates a recipient nor gets absorbed into previous block',()=>{
  const r=plan('Степан: Его наблюдение.\nБоря: Чужой текст.',{
    profiles:[parent('9000000003','kid_stepan')]});
  assert.equal(r.recipients.length,1);
  assert.doesNotMatch(r.recipients[0].text,/Боря|Чужой/);
});
test('unknown second Sasha heading blocks a bare first Sasha block',()=>{
  const r=plan('Саша — Сегодня читала.\nСаша Ив. — Сегодня играла.',{
    profiles:[parent('9000000001','kid_ivanova')]});
  assert.deepEqual(r.recipients,[]);
});
test('previous block owner protects against reassignment to another registered child',()=>{
  const r=plan('Саша Иг. — Читала.',{priorBlockOwners:[{childId:'kid_ivanova'}]});
  assert.equal(r.recipients.length,0);
  assert.equal(r.unresolved.length,1);
});
test('with zero registered children a staff source is still accepted and preserved',()=>{
  const raw='Саша Ив. — Писала.\nСтепан: Играли.';
  const r=plan(raw,{profiles:[]});
  assert.equal(r.normalizedText,raw);
  assert.equal(r.recipients.length,0);
  assert.equal(r.owners.length,2);
});
test('therapy is common to every registered parent including unlinked',()=>{
  const r=planCurrentReport({kind:'psychology',rawText:'Групповая терапия.\n\nВыводы.',
    profiles:[parent('9000000001',''),parent('9000000002','kid_stepan')]});
  assert.equal(r.recipients.length,2);
  assert.equal(r.recipients[0].text,r.recipients[1].text);
});
test('individual report version changes with child identity or publication',()=>{
  assert.notEqual(currentReportVersion({kind:'morning',childId:'child1',text:'A'}),
    currentReportVersion({kind:'morning',childId:'child2',text:'A'}));
  assert.notEqual(currentReportVersion({kind:'morning',childId:'child1',text:'A',publicationId:'a'}),
    currentReportVersion({kind:'morning',childId:'child1',text:'A',publicationId:'b'}));
});
