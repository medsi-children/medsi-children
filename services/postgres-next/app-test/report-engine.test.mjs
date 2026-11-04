import test from 'node:test';
import assert from 'node:assert/strict';
import { planLegacyReport } from '../app/report-engine.mjs';

function profile(phone10, childName, surname, admissionId='admission_001') {
  return { phone10, childName, surname, admissionId, parentName: 'Тестовый родитель' };
}
function input(children, text, more={}) {
  return {
    kind:'morning', rawText:text,
    profiles:children,
    nameVariants:[{preferredName:'Катя', variants:'Екатерина'}, {preferredName:'Тая', variants:'Таисия, Тася'}],
    ownerRecords:{}, ...more
  };
}
test('Node runtime preserves exact legacy report canonicalization, initials and punctuation', () => {
  const result = planLegacyReport(input([
    profile('9000000001', 'Лиза', 'Федорова')
  ], 'Лиза Ф: Утром играла ,общалась ( очень активно ).\nПосле обеда читала ,отдыхала.'));
  assert.equal(result.normalizedText,
    'Лиза Ф. — Утром играла, общалась (очень активно). После обеда читала, отдыхала.');
  assert.equal(result.recipients.length, 1);
  assert.match(result.recipients[0].text, /Лиза: Утром играла, общалась/);
  assert.equal(result.validation.ok, true);
});

test('two parents of the same child receive identical report without cross-child leak', () => {
  const profiles=[
    profile('9000000001','Екатерина','Громова','admission_one'),
    profile('9000000002','Екатерина','Громова','admission_one'),
    profile('9000000003','Таисия','Тестовая','admission_two')
  ];
  const r=planLegacyReport(input(profiles,
    'Катя Г: Синтетический блок К.\nТася Т: Синтетический блок Т.'));
  assert.equal(r.recipients.length, 3);
  assert.equal(r.recipients[0].text,r.recipients[1].text);
  assert.match(r.recipients[0].text,/Синтетический блок К/);
  assert.match(r.recipients[2].text,/Синтетический блок Т/);
  assert.doesNotMatch(r.recipients[2].text,/Синтетический блок К/);
});

test('ambiguous initials are quarantined, not distributed to namesakes', () => {
  const profiles=[
    profile('9000000001','Саша','Бурова','admission_one'),
    profile('9000000002','Саша','Березкин','admission_two'),
    profile('9000000003','Таисия','Тестовая','admission_three')
  ];
  const r=planLegacyReport(input(profiles,
    'Саша Б: Неоднозначный синтетический блок.\nТася Т: Однозначный синтетический блок.'));
  assert.match(r.recipients[0].text,/Пока ещё нет отчёта/);
  assert.match(r.recipients[1].text,/Пока ещё нет отчёта/);
  assert.match(r.recipients[2].text,/Однозначный синтетический блок/);
});

test('same raw report gets identical distribution even if roster rows reordered', () => {
  const profiles=[
    profile('9000000001','Александра','Бурова','admission_001'),
    profile('9000000002','Александр','Березкин','admission_002'),
    profile('9000000003','Катя','Громова','admission_003')
  ];
  const raw='Александра Бу: Синтетический блок девочки.\nАлександр Бе: Блок мальчика.\nКатя Г: Блок Кати.';
  const a=planLegacyReport(input(profiles,raw));
  const b=planLegacyReport(input([profiles[2],profiles[0],profiles[1]],raw));
  const asMap = r => new Map(r.recipients.map(v=>[v.phone10,v.text]));
  assert.deepEqual([...asMap(a)].sort(),[...asMap(b)].sort());
});

test('report history owner guard prevents another admission inheriting the same block', () => {
  const a=planLegacyReport(input([profile('9000000001','Лена','Тестовая','admission_old')],
    'Лена Т: Контрольный синтетический текст.'));
  assert.ok(Object.keys(a.ownerWrites).length);
  assert.throws(() => planLegacyReport(input(
    [profile('9000000009','Лена','Тестовая','admission_new')],
    'Лена Т: Контрольный синтетический текст.', {ownerRecords:a.ownerWrites})),/другим ребёнком|past|conflict|linked|Report blocked|Отчёт не сохранён/i);
});

test('format validation refuses duplicate headers and unknown/empty active roster', () => {
  assert.throws(() => planLegacyReport(input(
    [profile('9000000001','Лена','Тестовая')],
    'Лена Т: Первая заметка.\nЛена Т: Вторая заметка.')), /повтор|два блока|найдено/i);
  assert.throws(() => planLegacyReport(input([], 'Лена Т: Запись.')),/roster/);
  assert.throws(() => planLegacyReport(input([
    profile('9000000001','Лена','Тестовая'),
    profile('9000000001','Лена','Тестовая')
  ],'Лена Т: Запись.')), /duplicated/);
});

test('psychology report is not split by child headings and reaches every active parent', () => {
  const r=planLegacyReport(input(
    [profile('9000000001','Лена','Тестовая'),profile('9000000002','Катя','Громова')],
    'Общая групповая терапия.\nИтог: обсуждение.', {kind:'psychology'}));
  assert.equal(r.recipients.length,2);
  assert.equal(r.recipients[0].text,r.recipients[1].text);
});
