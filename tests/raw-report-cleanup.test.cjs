const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'postgres-next', 'legacy-report-source', 'Медси бот.js'),
  'utf8'
);

function rawReportTools() {
  const emptySheet = { getDataRange: () => ({ getValues: () => [[]] }) };
  const context = {
    console,
    Logger: { log() {} },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => emptySheet }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => name === 'MEDSI_SPREADSHEET_ID' ? 'synthetic-sheet' : ''
      })
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/postgres-next/legacy-report-source/report-rules.js'), 'utf8'), context);
  for (const file of ['report-names.js', 'report-parser.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/postgres-next/legacy-report-source', file), 'utf8'), context);
  }
  vm.runInContext(source, context);
  return context;
}

function target(api, childName, familyName) {
  return api.rawReportChildTargetFromReportRow_(['', '', childName, familyName]);
}

test('raw cleanup removes only the selected child block when first names match', () => {
  const api = rawReportTools();
  const kirillSh = target(api, 'Кирилл Ш.', 'Шевченко');
  const kirillM = target(api, 'Кирилл М.', 'Морозов');
  const raw = [
    'Кирилл Ш.: Был на занятии.',
    'Кирилл М.: Рисовал и гулял.',
    'Для врачей: Общий комментарий.'
  ].join('\n');

  const result = api.removeRawReportBlocksForChildren_(raw, [kirillSh], [kirillSh, kirillM]);

  assert.equal(result.removedBlocks, 1);
  assert.doesNotMatch(result.text, /Кирилл Ш\./);
  assert.match(result.text, /Кирилл М\.: Рисовал и гулял\./);
  assert.match(result.text, /Для врачей: Общий комментарий\./);
});

test('an ambiguous one-letter initial is preserved instead of deleting another child', () => {
  const api = rawReportTools();
  const kirillShir = target(api, 'Кирилл Ш.', 'Широков');
  const kirillShest = target(api, 'Кирилл Ш.', 'Шестаков');
  const raw = [
    'Кирилл Ш.: Текст, который нельзя угадать.',
    'Кирилл Шест: Другой ребёнок.'
  ].join('\n');

  const result = api.removeRawReportBlocksForChildren_(raw, [kirillShir], [kirillShir, kirillShest]);

  assert.equal(result.removedBlocks, 0);
  assert.equal(result.text, raw);
});

test('a longer surname prefix safely removes the right child when initials collide', () => {
  const api = rawReportTools();
  const kirillShir = target(api, 'Кирилл Ш.', 'Широков');
  const kirillShest = target(api, 'Кирилл Ш.', 'Шестаков');
  const raw = [
    'Кирилл Шир: Первый ребёнок.',
    'Кирилл Шест: Второй ребёнок.'
  ].join('\n');

  const result = api.removeRawReportBlocksForChildren_(raw, [kirillShir], [kirillShir, kirillShest]);

  assert.equal(result.removedBlocks, 1);
  assert.doesNotMatch(result.text, /Кирилл Шир/);
  assert.match(result.text, /Кирилл Шест: Второй ребёнок\./);
});

test('removing one parent does not erase a child who still has another REPORTS row', () => {
  const api = rawReportTools();
  const childForFirstParent = target(api, 'Кирилл Ш.', 'Шевченко');
  const childForSecondParent = target(api, 'Кирилл Ш.', 'Шевченко');
  const raw = 'Кирилл Ш.: Этот блок нужен второму родителю.';
  const targets = api.rawReportTargetsNoLongerActive_([childForFirstParent], [childForSecondParent]);

  assert.deepEqual(Array.from(targets), []);
  assert.equal(api.removeRawReportBlocksForChildren_(raw, targets, [childForSecondParent]).text, raw);
});

test('legacy lifecycle snapshots still derive a conservative initial', () => {
  const api = rawReportTools();
  const result = api.rawReportChildTargetFromProfileSnapshot_({ childName: 'Кирилл Шевченко' });

  assert.equal(result.baseKey, 'кирилл');
  assert.equal(result.suffixKey, 'ш');
  assert.equal(result.familyKey, 'шевченко');
});
