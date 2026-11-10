import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCurrentReportPunctuation as clean} from '../app/current-report-punctuation.mjs';
import {planCurrentReport} from '../app/current-report-plan.mjs';
import {assembleCurrentEducatorDashboard} from '../app/current-educator-dashboard.mjs';

test('restores legacy Apps Script comma, period and parenthesis spacing without changing words',()=>{
  const input='Александр: занимался с психологом ,был на ЭЭГ,после встречи ( с мамой ) вернулся в комнату .';
  assert.equal(clean(input),
    'Александр: занимался с психологом, был на ЭЭГ, после встречи (с мамой) вернулся в комнату.');
});

test('does not change decimal numbers, times, abbreviations, headers, or authored paragraph breaks',()=>{
  const input='Саша Ив. — 1,5 часа в 12:30.ЭЭГ прошла.\n\nАлександр: играл в 3,5 игры.';
  assert.equal(clean(input),
    'Саша Ив. — 1,5 часа в 12:30. ЭЭГ прошла.\n\nАлександр: играл в 3,5 игры.');
  assert.equal(clean(clean(input)),clean(input));
});

test('staff publication retains the exact original while distributing corrected individual text',()=>{
  const raw='Александр — Пообщался с мамой ,вернулся в хорошем состоянии .\n'+
    'Другой: Чужой блок ,не должен попадать Александру.';
  const result=planCurrentReport({kind:'morning',rawText:raw,
    profiles:[{phone10:'9000000001',child_id:'kid_alex'}],
    children:[{child_id:'kid_alex',registered_first_name:'Александр',surname:'Тестов'}]});
  assert.equal(result.rawText,raw);
  assert.match(result.normalizedText,/мамой, вернулся/);
  assert.match(result.recipients[0].text,/мамой, вернулся в хорошем состоянии\./);
  assert.doesNotMatch(result.recipients[0].text,/Чужой блок/);
});

test('shared psychotherapy preserves blank paragraphs and is normalized for both parents',()=>{
  const raw='Групповая терапия .\n\nУчастники беседовали ,поиграли ( вместе ).';
  const result=planCurrentReport({kind:'psychology',rawText:raw,
    profiles:[{phone10:'9000000001'},{phone10:'9000000002'}]});
  const expected='Групповая терапия.\n\nУчастники беседовали, поиграли (вместе).';
  assert.equal(result.rawText,raw);
  assert.equal(result.normalizedText,expected);
  assert.deepEqual(result.recipients.map(r=>r.text),[expected,expected]);
});

test('educator preview cleans already stored report text but retains authored raw source',()=>{
  const source={publication_id:'report_morning_123',kind:'morning',report_date:'2026-11-10',
    normalized_text:'Александр — Гулял ,играл .',raw_text:'Александр — Гулял ,играл .'};
  const v=assembleCurrentEducatorDashboard({
    children:[{child_id:'kid_alex',registered_first_name:'Александр',surname:'Тестов'}],
    profiles:[{phone10:'9000000001',child_id:'kid_alex',parent_name:'Родитель'}],
    heads:[{kind:'morning',publication_id:'report_morning_123'}],
    current:[{phone10:'9000000001',child_id:'kid_alex',kind:'morning',
      publication_id:'report_morning_123',text:'Александр: Гулял ,играл .'}],
    rawByPublication:new Map([['report_morning_123',source]])
  });
  assert.equal(v.children[0].parentViews[0].reports.morning,'Александр: Гулял, играл.');
  assert.equal(v.raw.morning.rawText,source.raw_text);
  assert.equal(v.raw.morning.displayText,'Александр — Гулял, играл.');
});
