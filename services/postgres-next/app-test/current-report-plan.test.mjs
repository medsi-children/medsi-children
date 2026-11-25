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


test('alert and emoji headers isolate registered and unregistered children without editing body punctuation',()=>{
  const first={child_id:'kid_alert_a',registered_first_name:'Арсен',surname:'Тестов'};
  const second={child_id:'kid_alert_b',registered_first_name:'Борис',surname:'Примеров'};
  for(const marker of ['!','!!!','！','❗','❗️','❕','❕️','‼','‼️','⁉️','⁈','❢','❣️','﹗','📌','⚠️','👨‍👩‍👧']){
    for(const heading of [marker+' Борис:',marker+'Борис —',
      ...(marker.match(/^[!！﹗❗❕‼⁉⁈❢❣\uFE0E\uFE0F]+$/u)?['Борис '+marker+':','Борис '+marker+' Пр. '+marker+' -']:[])]){
      for(const registered of [false,true]){
        const rawText='Арсен: Первый синтетический блок! ❗\n\n'+heading+' Второй синтетический блок! ❕\nПродолжение.';
        const result=planCurrentReport({kind:'evening',rawText,children:[first,second],
          profiles:[parent('9000000081',first.child_id),...(registered?[parent('9000000082',second.child_id)]:[])]});
        assert.equal(result.rawText,rawText);
        assert.equal(result.owners.length,2,heading);
        assert.equal(result.recipients[0].text,'Арсен: Первый синтетический блок!',heading);
        assert.doesNotMatch(result.recipients[0].text,/Борис|Второй|Продолжение/);
        if(registered)assert.equal(result.recipients[1].text,'Борис: Второй синтетический блок!\nПродолжение.');
        // Canonical persisted headers remain readable with the old grammar;
        // future recovery must preserve the exact publication/block indexes.
        const recovered=planCurrentReport({kind:'evening',rawText:result.normalizedText,
          children:[first,second],profiles:[parent('9000000081',first.child_id)],
          priorBlockOwners:result.owners,storedSource:true});
        assert.equal(recovered.owners.length,2);
        assert.equal(recovered.recipients[0].text,result.recipients[0].text);
      }
    }
  }
});
test('decorated namesakes still require distinctive surname prefixes',()=>{
  assert.equal(plan('❗ Саша: Первый.\n‼️ Саша: Второй.').recipients.length,0);
  const result=plan('❗ Саша Ив. ! — Первый.\n‼️ Саша Иг. ❕: Второй.');
  assert.deepEqual(result.recipients.map(r=>r.phone10),['9000000001','9000000002']);
  assert.doesNotMatch(result.recipients[0].text,/Второй/);
});

test('published and recovered reports exclude isolated ward labels but keep meaningful room references',()=>{
  const raw='501\nСаша Ив. — Играла, затем была в палате 503.\n'+
    'Палата № 503\nСаша Иг. — Собрала 503 элемента.\n512';
  const result=plan(raw);
  assert.equal(result.rawText,raw,'The source authored by educators remains intact');
  assert.equal(result.normalizedText,
    'Саша Ив. — Играла, затем была в палате 503.\n'+
    'Саша Иг. — Собрала 503 элемента.');
  assert.deepEqual(result.owners.map(o=>o.index),[0,1]);
  assert.deepEqual(result.recipients.map(r=>r.phone10),['9000000001','9000000002']);
  assert.match(result.recipients[0].text,/палате 503/);
  assert.match(result.recipients[1].text,/503 элемента/);
  assert.ok(result.recipients.every(r=>!/(^|\n)\s*(?:501|503|512)\s*(\n|$)/.test(r.text)));
  const restored=planCurrentReport({kind:'morning',rawText:raw,children,
    profiles:[parent('9000000001','kid_ivanova'),parent('9000000002','kid_ignatieva')],
    nameVariants:variants,priorBlockOwners:result.owners,storedSource:true});
  assert.deepEqual(restored.recipients.map(r=>r.text),result.recipients.map(r=>r.text));
  assert.equal(restored.owners.length,2,'Published owner block indexes remain stable');
});


test('age-style child header distributes only to a unique matching child',()=>{
  const raw='Степан: Синтетическая запись первого ребёнка.\n'+
    '❗️Саша Иг., 12 лет. Синтетическая запись второго ребёнка.';
  const result=plan(raw);
  assert.equal(result.rawText,raw);
  assert.match(result.normalizedText,/Саша Иг\.: 12 лет\. Синтетическая запись/);
  assert.deepEqual(result.recipients.map(r=>r.phone10),['9000000002','9000000003']);
  assert.match(result.recipients[0].text,/12 лет\. Синтетическая запись второго ребёнка/);
  assert.doesNotMatch(result.recipients[1].text,/второго ребёнка/);
});

test('ambiguous and absent age headings are separated and never auto-assigned',()=>{
  const uncertain=plan('Саша И., 12 лет. Синтетическое наблюдение.');
  assert.equal(uncertain.recipients.length,0);
  const other=plan('Степан: Синтетическая запись.\n'+
    'Мария Г., 12 лет. Отдельное синтетическое наблюдение.');
  assert.deepEqual(other.recipients.map(r=>r.phone10),['9000000003']);
  assert.doesNotMatch(other.recipients[0].text,/Мария|Отдельное/);
  assert.equal(other.owners.length,2);
});
