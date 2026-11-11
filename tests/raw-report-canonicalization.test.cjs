const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'postgres-next', 'legacy-report-source', 'Медси бот.js'),
  'utf8'
);

function api(nameVariantRows = []) {
  const emptySheet = { getLastRow: () => 1, getDataRange: () => ({ getValues: () => [[]] }) };
  const nameVariantsSheet = {
    getLastRow: () => nameVariantRows.length + 1,
    getDataRange: () => ({
      getValues: () => [['Имя-ориентир', 'Варианты'], ...nameVariantRows]
    })
  };
  const context = {
    console,
    Logger: { log() {} },
    Utilities: { getUuid: (() => { let next = 0; return () => '00000000-0000-4000-8000-' + String(++next).padStart(12, '0'); })() },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: name => name === 'NAME_VARIANTS' ? nameVariantsSheet : emptySheet
      })
    },
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../services/postgres-next/legacy-report-source/report-admissions.js'), 'utf8'), context);
  vm.runInContext(source, context);
  return context;
}

function child(api, name, family, phone) {
  const out = api.buildReportChildren_(
    [api.normalizeReportChildName_(name, family)],
    [family]
  )[0];
  out.phone = phone || '';
  out.phone10 = api.last10_(phone || '');
  return out;
}

test('canonicalizer normalizes initial punctuation and delimiter without touching the body', () => {
  const x = api();
  const lisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const variants = [
    'Лиза Ф: Текст с авторской формулировкой.',
    'Лиза Ф.: Текст с авторской формулировкой.',
    'Лиза Ф - Текст с авторской формулировкой.',
    'Лиза: Текст с авторской формулировкой.'
  ];

  variants.forEach(raw => {
    const result = x.canonicalizeRawChildReport_(raw, { children:[lisa] });
    assert.equal(result.text, 'Лиза Ф. — Текст с авторской формулировкой.');
  });
});

test('report submission repairs spacing and flattens each child body into one paragraph', () => {
  const x = api();
  const lisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const raw = 'Лиза Ф: Утром играла ,общалась ( очень активно ).\nПосле обеда читала ,отдыхала.';
  const result = x.canonicalizeRawChildReport_(raw, { children:[lisa] });

  assert.equal(
    result.text,
    'Лиза Ф. — Утром играла, общалась (очень активно). После обеда читала, отдыхала.'
  );

  const parsed = x.parseReportBlocks_(result.text, x.buildKnownBaseKeys_([lisa]), x.buildDistributionContext_([lisa], []));
  assert.equal(parsed.blocks[0].body, 'Утром играла, общалась (очень активно). После обеда читала, отдыхала.');
  assert.equal(
    x.normalizeReportBlockBody_(parsed.blocks[0].body),
    x.normalizeReportBlockBody_('Утром играла, общалась (очень активно). После обеда читала, отдыхала.')
  );

  const masha=child(x,'Маша','Сидорова','89990000002');
  const twoChildren=x.canonicalizeRawChildReport_(
    'Лиза Ф: Текст первого ребёнка.\n\n\nМаша С: Текст второго ребёнка.',
    {children:[lisa,masha]}
  );
  assert.equal(twoChildren.text,'Лиза Ф. — Текст первого ребёнка.\nМаша С. — Текст второго ребёнка.');
  assert.equal(x.parseReportBlocks_(twoChildren.text,x.buildKnownBaseKeys_([lisa,masha]),x.buildDistributionContext_([lisa,masha],[])).blocks.length,2);
});


test('manual and queued reports flatten many paragraphs without merging children', () => {
  const x = api();
  const lena = child(x, 'Лена', 'Тестовая', '89990000001');
  const masha = child(x, 'Маша', 'Учебная', '89990000002');
  const stepan = child(x, 'Степан', 'Условная', '89990000003');
  x.buildReportValidationChildren_ = () => [lena, masha, stepan];
  const raw = [
    'Синтетический вечерний отчёт',
    'Игры и общение',
    '',
    'Лена: Первая фраза.',
    '',
    'Вторая фраза без заголовка.',
    '',
    '',
    'Третья фраза.',
    '',
    'Маша: Начало.',
    'Продолжение на новой строке.',
    'Ещё одно предложение.',
    '',
    'Степан: Самостоятельный блок.'
  ].join('\n');
  const expected = [
    'Лена Т. — Первая фраза. Вторая фраза без заголовка. Третья фраза.',
    'Маша У. — Начало. Продолжение на новой строке. Ещё одно предложение.',
    'Степан У. — Самостоятельный блок.'
  ].join('\n');
  const prepared = x.prepareRawReportSourceText_('evening', raw);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.text, expected);
  const context = x.buildDistributionContext_([lena,masha,stepan], []);
  const parsed = x.parseReportBlocks_(prepared.text,x.buildKnownBaseKeys_([lena,masha,stepan]),context);
  assert.equal(parsed.blocks.length, 3);
  assert.ok(parsed.blocks.every(block => !block.body.includes('\n')));
  // Distribution also flattens older raw sources that still have line breaks.
  const legacy = x.parseReportBlocks_(raw, x.buildKnownBaseKeys_([lena,masha,stepan]), context);
  assert.equal(legacy.blocks.length, 3);
  assert.ok(legacy.blocks.every(block => !block.body.includes('\n')));
});

test('room number before a child header is removed without consuming the name separator', () => {
  const x = api();
  const lisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const raw = [
    '501: Лиза Ф.: Была на встрече в 17:00.',
    '502 Маша — Играла в настольные игры.',
    '503\nЛиза Ф. — Отдыхала.',
    '№ 504:\nМаша: Читала книгу.'
  ].join('\n');

  assert.equal(
    x.stripRoomNumbers_(raw),
    'Лиза Ф.: Была на встрече в 17:00.\nМаша — Играла в настольные игры.\nЛиза Ф. — Отдыхала.\nМаша: Читала книгу.'
  );
  const result = x.canonicalizeRawChildReport_(raw, { children:[lisa] });
  assert.equal(
    result.text,
    'Лиза Ф. — Была на встрече в 17:00.\nМаша — Играла в настольные игры.\nЛиза Ф. — Отдыхала.\nМаша — Читала книгу.'
  );
  assert.equal(result.changed, true);
  assert.equal(
    x.stripRoomNumbers_('Лиза Ф.: В 17:00 обсуждали комнату 501: всё спокойно.'),
    'Лиза Ф.: В 17:00 обсуждали комнату 501: всё спокойно.'
  );
});

test('room label after report boilerplate does not remove the first child', () => {
  const x = api();
  const lena = child(x, 'Лена', 'Тестовая', '89990000001');
  const masha = child(x, 'Маша', 'Учебная', '89990000002');
  lena.index = 0;
  masha.index = 1;
  const raw = [
    'Вечерний отчёт',
    'Игры и общение',
    '',
    '501: Лена — Первое вымышленное предложение.',
    '502: Маша — Второе вымышленное предложение.'
  ].join('\n');
  const context = x.buildDistributionContext_([lena, masha], []);
  x.buildReportValidationChildren_ = () => [lena, masha];
  for (const variant of ['501: Лена', '501 Лена', '501:\nЛена', '501\nЛена', '№ 501: Лена', '501 / Лена', '501 — Лена', '501, Лена', 'Палата № 501: Лена']) {
    const prepared = x.prepareRawReportSourceText_('evening', raw.replace('501: Лена', variant));
    assert.equal(prepared.ok, true);
    assert.equal(prepared.text,
      'Лена Т. — Первое вымышленное предложение.\nМаша У. — Второе вымышленное предложение.');
    const parsed = x.parseReportBlocks_(prepared.text, x.buildKnownBaseKeys_([lena, masha]), context);
    const distributed = x.buildSafeDistribution_('evening', parsed, context);
    assert.match(distributed.byRow[0], /^Лена: Первое вымышленное предложение\.$/);
    assert.match(distributed.byRow[1], /^Маша: Второе вымышленное предложение\.$/);
  }
});

test('a doctors section is rejected before child report cleanup, with or without rooms', () => {
  const x = api();
  const lena = child(x, 'Лена', 'Тестовая', '89990000001');
  x.buildReportValidationChildren_ = () => [lena];
  for (const marker of ['Для врачей:', '❗Для врачей']) {
    const raw = [
      'Вечерний отчёт',
      marker,
      'Лена — Служебная запись.',
      '501: Лена — Основной текст.'
    ].join('\n');
    const prepared = x.prepareRawReportSourceText_('evening', raw);
    assert.equal(prepared.ok, false);
    assert.equal(prepared.message, 'Найден блок для врачей, пожалуйста, удалите его.');
    assert.equal(prepared.text, raw);
  }
});

test('two blocks for one child are rejected even with a bare name and no rooms', () => {
  const x = api();
  const lena = child(x, 'Лена', 'Тестовая', '89990000001');
  x.buildReportValidationChildren_ = () => [lena];
  const prepared = x.prepareRawReportSourceText_('evening',
    'Лена — Первая запись.\nЛена — Вторая запись.');
  assert.equal(prepared.ok, false);
  assert.match(prepared.message, /повторяется/);
});

test('admissions are preamble when the doctors section has been removed', () => {
  const x = api();
  const lena = child(x, 'Лена', 'Тестовая', '89990000001');
  x.buildReportValidationChildren_ = () => [lena];
  const prepared = x.prepareRawReportSourceText_('morning',
    'Поступление:\nНовый ребёнок, 16 лет\nЛена: Основной текст.');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.text, 'Лена Т. — Основной текст.');
});

test('room numbers inside a child body are preserved', () => {
  const x = api();
  const raw = 'Лена — Комната 501: свободна. В 17:00 переход в 502 палату. Номер 1501 и число 3.501 остаются.';
  assert.equal(x.stripRoomNumbers_(raw),
    raw);
  assert.equal(x.stripRoomNumbers_('503:\n  Лена — Текст.\nМаша — Текст.'),
    'Лена — Текст.\nМаша — Текст.');
});

test('unregistered child keeps a bare name, while an explicit initial gets a dot', () => {
  const x = api();
  assert.equal(
    x.canonicalizeRawChildReport_('Лиза: Пока без регистрации.', { children:[] }).text,
    'Лиза — Пока без регистрации.'
  );
  assert.equal(
    x.canonicalizeRawChildReport_('Лиза М: Пока без регистрации.', { children:[] }).text,
    'Лиза М. — Пока без регистрации.'
  );
});

test('an old bare name is recovered when a second same-named child appears and previous assignment is confirmed', () => {
  const x = api();
  const oldLisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const newLisa = child(x, 'Лиза', 'Морозова', '89990000002');

  const result = x.canonicalizeRawChildReport_(
    'Лиза: Старый уже распределённый текст.',
    {
      children:[oldLisa, newLisa],
      previousChildren:[oldLisa],
      confirmPreviousAssignment:payload => (
        payload.previousTargets.length === 1 &&
        payload.currentTargets.length === 1 &&
        payload.currentTargets[0].phone10 === '9990000001'
      )
    }
  );

  assert.equal(result.text, 'Лиза Ф. — Старый уже распределённый текст.');
  assert.equal(result.recovered, 1);
  assert.deepEqual(Array.from(result.unresolved), []);
});

test('an ambiguous old bare name is never guessed without proof', () => {
  const x = api();
  const oldLisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const newLisa = child(x, 'Лиза', 'Морозова', '89990000002');

  const result = x.canonicalizeRawChildReport_(
    'Лиза: Нельзя угадывать.',
    {
      children:[oldLisa, newLisa],
      previousChildren:[oldLisa],
      confirmPreviousAssignment:() => false
    }
  );

  assert.equal(result.text, 'Лиза: Нельзя угадывать.');
  assert.deepEqual(Array.from(result.unresolved), ['Лиза']);
});

test('same surname initial escalates to the shortest supported unique prefix', () => {
  const x = api();
  const wide = child(x, 'Кирилл', 'Широков', '89990000003');
  const six = child(x, 'Кирилл', 'Шестаков', '89990000004');

  const result = x.canonicalizeRawChildReport_(
    'Кирилл Шир: Первый ребёнок.\nКирилл Шест: Второй ребёнок.',
    { children:[wide, six] }
  );

  assert.equal(
    result.text,
    'Кирилл Ши — Первый ребёнок.\nКирилл Ше — Второй ребёнок.'
  );
});

test('service headers are preserved and are not mistaken for children', () => {
  const x = api();
  const lisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const result = x.canonicalizeRawChildReport_(
    'Лиза: Всё хорошо.\nДля врачей: Наблюдение без изменений.',
    { children:[lisa] }
  );

  assert.equal(
    result.text,
    'Лиза Ф. — Всё хорошо.\nДля врачей: Наблюдение без изменений.'
  );
});


test('a child name without colon or dash is plain text, never a canonicalized header', () => {
  const x = api();
  const lisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const raw = 'Маша: Сегодня общалась с Лиза Ф\nЛиза Ф потом присоединилась к игре.';
  const result = x.canonicalizeRawChildReport_(raw, { children:[lisa] });

  assert.equal(
    result.text,
    'Маша — Сегодня общалась с Лиза Ф Лиза Ф потом присоединилась к игре.'
  );
  assert.doesNotMatch(result.text, /Лиза Ф\. —/);
});


test('canonicalizer removes report boilerplate before the first explicit child header', () => {
  const x = api();
  const artemK = child(x, 'Артём', 'Кузнецов', '89990000005');
  const artemI = child(x, 'Артём', 'Иванов', '89990000006');
  const raw = [
    '# 🐸 ОТЧЕТ ПО ДЕТЯМ: ВЕЧЕР',
    '6 октября 🌙 День-вечер',
    'Сегодня у ребят были:',
    '💃 Танцы',
    '🎨 Творчество',
    '💬 Общение',
    '🎲 Настольные игры',
    '🍿 Киносеанс',
    '',
    'Отчёт составили: Денис и Лиза',
    '•••',
    '',
    'Артём К. - В целом поведение приемлемое.',
    'Артём И. - Сегодня хорошо поужинал.'
  ].join('\n');

  const result = x.canonicalizeRawChildReport_(raw, { children:[artemK, artemI] });

  assert.equal(
    result.text,
    'Артём К. — В целом поведение приемлемое.\nАртём И. — Сегодня хорошо поужинал.'
  );
  assert.equal(result.preambleRemoved, true);
  assert.doesNotMatch(result.text, /ОТЧЕТ ПО ДЕТЯМ|Сегодня у ребят были|Отчёт составили|Танцы|Киносеанс/);
});

test('preamble trimming never starts from a bare child-name mention without a delimiter', () => {
  const x = api();
  const lisa = child(x, 'Лиза', 'Федорова', '89990000001');
  const raw = [
    'Служебная строка',
    'Лиза Ф была на прогулке',
    'Лиза Ф: Настоящий блок отчёта.'
  ].join('\n');

  const result = x.canonicalizeRawChildReport_(raw, { children:[lisa] });
  assert.equal(result.text, 'Лиза Ф. — Настоящий блок отчёта.');
});

test('room cleanup preserves multiline child content and removes only separate labels', () => {
  const x=api();
  const raw=[
    '10.10.2026 Утро',
    'Поступление: 508 Новый ребёнок, 16 лет',
    '501: Лена — Обсуждала комнату 502: всё спокойно.',
    'В игре получила 503 балла; записала 17:00 и 1,5.',
    '504',
    'Это число относится к предыдущему предложению.',
    'Палата № 505:',
    '',
    '506 Маша: Упомянула палату 507. Число 508 осталось в тексте.',
    '509'
  ].join('\n');
  const clean=x.stripRoomNumbers_(raw);
  assert.match(clean,/Лена — Обсуждала комнату 502: всё спокойно/);
  assert.match(clean,/503 балла; записала 17:00 и 1,5/);
  assert.match(clean,/\n504\nЭто число/);
  assert.doesNotMatch(clean,/Палата № 505/);
  assert.match(clean,/Маша: Упомянула палату 507. Число 508 осталось/);
  assert.match(clean,/\n509$/);
  assert.doesNotMatch(clean,/501: Лена|506 Маша/);
  const children=[child(x,'Лена','Тестовая'),child(x,'Маша','Учебная')];
  x.buildReportValidationChildren_=()=>children;
  const prepared=x.prepareRawReportSourceText_('morning',raw);
  assert.equal(prepared.ok,true);
  const parsed=x.parseReportBlocks_(prepared.text,x.buildKnownBaseKeys_(children),x.buildDistributionContext_(children,[]));
  assert.match(parsed.blocks[0].body,/комнату 502:/);
  assert.match(parsed.blocks[0].body,/504 Это число/);
  assert.match(parsed.blocks[1].body,/палату 507/);
  assert.match(parsed.blocks[1].body,/509$/);
});

test('web and manual sheet edits share structural rules and allow correctable formatting', () => {
  const x=api();
  const web=require('../tutors/report-validation.js');
  const children=[child(x,'Лена','Тестовая'),child(x,'Маша','Учебная')];
  x.buildReportValidationChildren_=()=>children;
  const examples=[
    ['Лена — Единственный ребёнок без инициала.',true],
    ['501: Лена Т : Текст .\nМаша У— Ещё текст ,без пробела.',true],
    ['Палата № 501\n  Лена Т. – В 17:00 съела 1,5 порции.',true],
    ['Лена — Первый блок.\nЛена Т. — Второй блок.',false],
    ['Лена — Первый блок.\nЛена — Второй блок.',false],
    ['Вова — Первый блок.\nВладимир — Второй блок.',false],
    ['📋 Общие комментарии： текст\nЛена — Основной блок.',false],
    ['**Для врача** — заметка\nЛена — Основной блок.',false]
  ];
  for(const [raw,expected] of examples){
    const frontend=web.validate('morning',raw);
    const sheet=x.prepareRawReportSourceText_('morning',raw);
    assert.equal(frontend.ok,expected,raw);
    assert.equal(sheet.ok,expected,raw);
    if(!expected)assert.equal(sheet.message,frontend.message);
  }
  let note='';
  const raw='Лена — Первый блок.\nЛена — Второй блок.';
  const cell={getValue:()=>raw,setNote:value=>{note=value;}};
  x.getLatestReportCell_=()=>cell;
  x.saveRawReportPublication_=()=>{throw new Error('Invalid source must not be saved or distributed');};
  x.distributeChildReports=()=>{throw new Error('Invalid source must not distribute');};
  const result=x.processRawReportSourceEdit_('morning',{});
  assert.equal(result.ok,false);
  assert.match(note,/повторяется/);
  assert.equal(cell.getValue(),raw);

  let saved='';
  const correctable='Лена Т: Была активна ,играла.\nПосле обеда отдыхала ,читала.';
  const validCell={getValue:()=>correctable,setNote(){},clearNote(){}};
  x.getLatestReportCell_=()=>validCell;
  x.saveRawReportPublication_=(kind,target,text)=>{saved=text;return true;};
  x.distributeChildReports=()=>{};
  const edited=x.processRawReportSourceEdit_('morning',{});
  assert.equal(edited.ok,true);
  assert.equal(saved,'Лена Т. — Была активна, играла. После обеда отдыхала, читала.');
});


test('NAME_VARIANTS uses the first column for raw display but keeps the registered parent name', () => {
  const x = api([['Владимир', 'Вова, Володя']]);
  const volodya = child(x, 'Володя', 'Сидоров', '89990000001');
  volodya.index = 0;

  assert.equal(x.normalizeReportChildName_('Володя', 'Сидоров'), 'Володя С');
  assert.equal(x.getNameBaseKey_('Володя'), x.getNameBaseKey_('Вова'));

  const context = x.buildDistributionContext_([volodya], []);
  const prepared = x.canonicalizeRawChildReport_(
    'Вова С: Спокойно участвовал в занятиях.',
    { children:[volodya] }
  );
  assert.equal(prepared.text, 'Владимир С. — Спокойно участвовал в занятиях.');

  const parsed = x.parseReportBlocks_(
    prepared.text,
    x.buildKnownBaseKeys_([volodya]),
    context
  );
  const distributed = x.buildSafeDistribution_('morning', parsed, context);
  assert.equal(distributed.byRow[0], 'Володя: Спокойно участвовал в занятиях.');
});

test('preferred neutral raw name keeps two Sasha aliases separated by surname while parents keep registered forms', () => {
  const x = api([['Саша', 'Александр, Александра']]);
  const alexander = child(x, 'Александр', 'Баженов', '89990000001');
  const alexandra = child(x, 'Александра', 'Букачёва', '89990000002');
  alexander.index = 0;
  alexandra.index = 1;
  const children = [alexander, alexandra];
  const raw = 'Александр Ба: Текст мальчика.\nАлександра Бу: Текст девочки.';

  const prepared = x.canonicalizeRawChildReport_(raw, { children });
  assert.equal(prepared.text, 'Саша Ба — Текст мальчика.\nСаша Бу — Текст девочки.');
  const context = x.buildDistributionContext_(children, []);
  const parsed = x.parseReportBlocks_(prepared.text, x.buildKnownBaseKeys_(children), context);
  const distributed = x.buildSafeDistribution_('morning', parsed, context);
  assert.equal(distributed.byRow[0], 'Александр: Текст мальчика.');
  assert.equal(distributed.byRow[1], 'Александра: Текст девочки.');
});

test('name without a NAME_VARIANTS entry keeps the educator spelling and still adds the surname initial', () => {
  const x = api();
  const childRow = child(x, 'Екатерина', 'Глотова', '89990000001');
  const prepared = x.canonicalizeRawChildReport_('Екатерина: Текст.', { children:[childRow] });
  assert.equal(prepared.text, 'Екатерина Г. — Текст.');
});

test('legacy surname qualifier is reconstructed only for matching and never written back to REPORTS', () => {
  const x = api();
  let writes = 0;
  const readOnlySheet = { getRange() { return { setValues() { writes += 1; } }; } };
  assert.equal(x.normalizeReportChildName_('Саша Б.', 'Баженов'), 'Саша Б');
  assert.equal(x.normalizeReportChildNames_(readOnlySheet, ['Саша Б.'], ['Баженов'])[0], 'Саша Б');
  assert.equal(x.stripStoredFamilyQualifier_('Анна-Мария', 'Баженова'), 'Анна-Мария');
  assert.equal(writes, 0);
});

test('NAME_VARIANTS spellings resolve by surname suffix and bare aliases stay ambiguous', () => {
  const x = api([['Александр', 'Саша, Александра']]);
  const alexander = child(x, 'Александр', 'Петров', '89990000011');
  const alexandra = child(x, 'Александра', 'Иванова', '89990000012');
  alexander.index = 0;
  alexandra.index = 1;
  const children = [alexander, alexandra];
  const context = x.buildDistributionContext_(children, []);
  const known = x.buildKnownBaseKeys_(children);

  const exact = x.parseReportBlocks_(
    'Александр П. — Первый текст.\nАлександра И. — Второй текст.',
    known,
    context
  );
  const exactDistribution = x.buildSafeDistribution_('morning', exact, context);
  assert.equal(exactDistribution.byRow[0], 'Александр: Первый текст.');
  assert.equal(exactDistribution.byRow[1], 'Александра: Второй текст.');

  const aliases = x.parseReportBlocks_(
    'Саша П. — Первый текст.\nСаша И. — Второй текст.',
    known,
    context
  );
  const aliasDistribution = x.buildSafeDistribution_('morning', aliases, context);
  assert.equal(aliasDistribution.byRow[0], 'Александр: Первый текст.');
  assert.equal(aliasDistribution.byRow[1], 'Александра: Второй текст.');

  const ambiguous = x.parseReportBlocks_('Саша — Нельзя угадывать.', known, context);
  const ambiguousDistribution = x.buildSafeDistribution_('morning', ambiguous, context);
  assert.deepEqual(Object.keys(ambiguousDistribution.byRow), []);
});

test('explicit male and female forms never cross even when NAME_VARIANTS links them', () => {
  const x = api([['Александр', 'Саша, Александра']]);
  const alexander = child(x, 'Александр', 'Петров', '89990000011');
  const alexandra = child(x, 'Александра', 'Иванова', '89990000012');
  alexander.index = 0;
  alexandra.index = 1;
  const children = [alexander, alexandra];
  const context = x.buildDistributionContext_(children, []);
  const parsed = x.parseReportBlocks_(
    'Александр И. — Отчёт Александры.',
    x.buildKnownBaseKeys_(children),
    context
  );
  const distributed = x.buildSafeDistribution_('morning', parsed, context);
  assert.equal(distributed.byRow[1], undefined);
});

test('shared Katya and Sasha aliases use the surname initial, including Latin K', () => {
  const x = api([
    ['Катя', 'Екатерина'],
    ['Саша', 'Александра']
  ]);
  const children = [
    child(x, 'Катя', 'Авдеева', '89990000021'),
    child(x, 'Екатерина', 'Глотова', '89990000022'),
    child(x, 'Саша', 'Бычкова', '89990000023'),
    child(x, 'Александра', 'Калягина', '89990000024')
  ];
  children.forEach((item, index) => { item.index = index; });
  const context = x.buildDistributionContext_(children, []);
  const known = x.buildKnownBaseKeys_(children);

  const bareKatya = x.parseReportBlocks_('Катя — Безопасно не угадываем.', known, context);
  const bareKatyaDistribution = x.buildSafeDistribution_('morning', bareKatya, context);
  assert.deepEqual(Object.keys(bareKatyaDistribution.byRow), []);
  const bareSasha = x.parseReportBlocks_('Саша — Безопасно не угадываем.', known, context);
  const bareSashaDistribution = x.buildSafeDistribution_('morning', bareSasha, context);
  assert.deepEqual(Object.keys(bareSashaDistribution.byRow), []);

  const aliases = x.parseReportBlocks_(
    'Катя Г. — Отчёт Екатерины.\nСаша K — Отчёт Александры.',
    known,
    context
  );
  const distributed = x.buildSafeDistribution_('morning', aliases, context);
  assert.equal(distributed.byRow[1], 'Екатерина: Отчёт Екатерины.');
  assert.equal(distributed.byRow[3], 'Александра: Отчёт Александры.');
});


function ownershipFixture(x) {
  const crypto = require('node:crypto');
  const props = new Map([['MEDSI_SPREADSHEET_ID','synthetic-sheet']]);
  x.reportFingerprint_ = text => crypto.createHash('sha256').update(String(text)).digest('hex');
  x.PropertiesService = { getScriptProperties:() => ({
    getProperty:key => props.get(key) || '', setProperty:(key,value) => props.set(key,value)
  }) };
  function distribute(raw, children, allowNew, previous = []) {
    const context = x.buildDistributionContext_(children, []);
    const parsed = x.parseReportBlocks_(raw, x.buildKnownBaseKeys_(children), context);
    return x.applyRawReportOwnershipGuard_('evening', parsed, context,
      x.buildSafeDistribution_('evening', parsed, context), previous, allowNew);
  }
  return {props,distribute};
}

test('two Sasha B children: a neutral initial is blocked, explicit forms or family prefixes disambiguate', () => {
  const x = api([['Саша', 'Александр, Александра']]);
  const girl = child(x, 'Александра Б', 'Бурова', '89990000001');
  const boy = child(x, 'Александр Б', 'Березкин', '89990000002');
  girl.index = 0; boy.index = 1;
  const children = [girl,boy];
  const ctx = x.buildDistributionContext_(children, []);
  const parse = raw => x.parseReportBlocks_(raw, x.buildKnownBaseKeys_(children), ctx);
  assert.deepEqual(Object.keys(x.buildSafeDistribution_('evening', parse('Саша Б — Текст.'), ctx).byRow), []);
  assert.equal(x.buildSafeDistribution_('evening', parse('Александр Б — Текст мальчика.'), ctx).byRow[1], 'Александр: Текст мальчика.');
  assert.equal(x.buildSafeDistribution_('evening', parse('Александра Б — Текст девочки.'), ctx).byRow[0], 'Александра: Текст девочки.');
  assert.equal(x.buildSafeDistribution_('evening', parse('Саша Бе — Текст мальчика.'), ctx).byRow[1], 'Александр: Текст мальчика.');
  assert.equal(x.buildSafeDistribution_('evening', parse('Саша Бу — Текст девочки.'), ctx).byRow[0], 'Александра: Текст девочки.');
});

test('a discharged Sasha report never transfers to a new admission after its heading becomes unique', () => {
  const x = api([['Саша', 'Александр, Александра']]);
  const f = ownershipFixture(x);
  const girl = child(x, 'Саша Б', 'Бурова', '89990000001');
  const boy = child(x, 'Саша Б', 'Березкин', '89990000002');
  girl.index = 0; boy.index = 0;
  const raw = 'Саша Б — Старый синтетический отчёт.';
  assert.ok(f.distribute(raw, [girl], true).byRow[0]);
  assert.equal(f.distribute(raw, [boy], false).byRow[0], undefined);
  assert.equal(f.distribute(raw, [boy], true).byRow[0], undefined); // Reposting the old body is not a new owner.
  assert.ok(f.distribute('Саша Б — Новый синтетический отчёт.', [boy], true).byRow[0]);
});

test('ambiguous block stays quarantined after discharge; an authored family prefix releases it', () => {
  const x = api([['Саша', 'Александр, Александра']]);
  const f = ownershipFixture(x);
  const girl = child(x, 'Саша Б', 'Бурова', '89990000001');
  const boy = child(x, 'Саша Б', 'Березкин', '89990000002');
  girl.index = 0; boy.index = 1;
  const raw = 'Саша Б — Неустановленная принадлежность.';
  f.distribute(raw, [girl,boy], false);
  assert.equal(f.distribute(raw, [boy], false).byRow[1], undefined);
  assert.equal(f.distribute(raw, [boy], true).byRow[1], undefined);
  x.buildReportValidationChildren_ = () => [boy];
  x.rememberRawReportPublicationOwnership_('evening', raw, 'Саша Бе — Неустановленная принадлежность.');
  assert.ok(f.distribute(raw, [boy], false).byRow[1]);
});

test('changing initials, aliases or roster order does not change report ownership', () => {
  const x = api([['Катя', 'Екатерина']]);
  const f = ownershipFixture(x);
  const original = child(x, 'Катя Б', 'Бурова', '89990000001'); original.index = 0;
  assert.ok(f.distribute('Катя Бу — Общий текст.', [original], true).byRow[0]);
  const renamed = child(x, 'Екатерина Б', 'Бурова', '89990000001'); renamed.index = 7;
  assert.ok(f.distribute('Екатерина Б — Общий текст.', [renamed], false).byRow[7]);
});

test('same full name with a different parent contact is a new admission, not the old report owner', () => {
  const x = api(); const f = ownershipFixture(x);
  const first = child(x, 'Миша Б', 'Быков', '89990000001'); first.index = 0;
  const second = child(x, 'Миша Б', 'Быков', '89990000002'); second.index = 0;
  const raw = 'Миша Б — Совпадающие имя и фамилия.';
  f.distribute(raw, [first], true);
  assert.equal(f.distribute(raw, [second], false).byRow[0], undefined);
});

test('bootstrap trusts only an existing matching assignment, never an empty newly registered row', () => {
  const x = api(); const f = ownershipFixture(x);
  const target = child(x, 'Миша Б', 'Быков', '89990000001'); target.index = 0;
  assert.equal(f.distribute('Миша Б — Чужой старый текст.', [target], false, ['Пока ещё нет отчёта 🙏']).byRow[0], undefined);
  assert.ok(f.distribute('Миша Б — Уже известный текст.', [target], false, ['Миша: Уже известный текст.']).byRow[0]);
});

test('canonical maintenance cannot rename a previous owner into a new child', () => {
  const x = api([['Саша', 'Александр, Александра']]);
  const girl = child(x, 'Саша Б', 'Бурова', '89990000001');
  const boy = child(x, 'Александр Б', 'Березкин', '89990000002');
  const result = x.canonicalizeRawChildReport_('Саша Б — Старый текст.', { children:[boy], previousChildren:[girl] });
  assert.match(result.text, /^Саша Б [—-] Старый текст\.$/);
  assert.equal(result.unresolved.length, 1);
});


test('final parent read barrier rejects another admission even if the wrong text is in its REPORTS row', () => {
  const x = api([['Саша', 'Александр, Александра']]); const f = ownershipFixture(x);
  const girl = child(x, 'Саша Б', 'Бурова', '89990000001'); girl.index = 0;
  const raw = 'Саша Б — Синтетический приватный текст.';
  f.distribute(raw, [girl], true);
  assert.equal(x.rawReportRowOwnershipAllows_('evening', ['89990000001','','Саша Б','Бурова','','Саша: Синтетический приватный текст.']), true);
  assert.equal(x.rawReportRowOwnershipAllows_('evening', ['89990000002','','Александр Б','Березкин','','Александр: Синтетический приватный текст.']), false);
});

test('admission ID lets another guardian see the same child report but blocks a later admission', () => {
  const x = api();
  const mom = child(x, 'Миша Б', 'Быков', '89990000001');
  const dad = child(x, 'Миша Б', 'Быков', '89990000002');
  const later = child(x, 'Миша Б', 'Быков', '89990000003');
  mom.childAdmissionId = dad.childAdmissionId = 'admission-current';
  later.childAdmissionId = 'admission-later';
  x.rawReportOwnerIdentity_ = () => 'same-child-identity';
  const owner = { identity:'same-child-identity', childAdmissionId:'admission-current', phones:['old-contact|old-token'] };
  assert.equal(x.rawReportOwnerMatches_(owner, [dad]), true);
  assert.equal(x.rawReportOwnerMatches_(owner, [later]), false);
});

test('REPORTS backfill shares one ID for the same active child and creates a fresh one after removal', () => {
  const x = api([['Екатерина','Катя']]);
  const values = [
    ['89990000001','Synthetic','Екатерина Г','Глотова','','','',''],
    ['89990000002','Synthetic','Катя Г','Глотова','','','','']
  ];
  let header = '';
  let hidden = false;
  const sheet = {
    getMaxColumns:() => 8,
    getLastRow:() => values.length + 1,
    getRange:(row, column, count, width) => ({
      getValue:() => row === 1 && column === 8 ? header : '',
      setValue:value => { if (row === 1 && column === 8) header = value; },
      getValues:() => values.slice(row - 2, row - 2 + (count || 1)).map(item => item.slice(column - 1, column - 1 + (width || 1))),
      setValues:items => items.forEach((item, index) => { values[row - 2 + index][column - 1] = item[0]; })
    }),
    isColumnHiddenByUser:() => false,
    hideColumns:() => { hidden = true; }
  };
  x.ensureReportAdmissionIds_(sheet);
  assert.equal(header, 'ID поступления (служебный)');
  assert.equal(hidden, true);
  assert.ok(values[0][7]);
  assert.equal(values[0][7], values[1][7]);
  const oldId = values[0][7];
  values.splice(0, values.length, ['89990000003','Synthetic','Екатерина Г','Глотова','','','','']);
  x.ensureReportAdmissionIds_(sheet);
  assert.notEqual(values[0][7], oldId);
});

test('a second parent of the same active child can see an existing owned report', () => {
  const x = api(); const f = ownershipFixture(x);
  const mom = child(x, 'Миша Б', 'Быков', '89990000001'); mom.index = 0;
  const dad = child(x, 'Миша Б', 'Быков', '89990000002'); dad.index = 1;
  const raw = 'Миша Б — Общий семейный текст.';
  f.distribute(raw, [mom], true);
  assert.ok(f.distribute(raw, [mom,dad], false).byRow[1]);
  assert.equal(x.rawReportRowOwnershipAllows_('evening', ['89990000002','','Миша Б','Быков','','Миша: Общий семейный текст.']), true);
});

test('roster reordering before write cancels distribution instead of writing into the wrong row', () => {
  const x = api(); const target = child(x, 'Миша Б', 'Быков', '89990000001'); target.index = 0;
  const sheet = {getLastRow:()=>2,getRange:(row,column)=>({getValues:()=>column===8?[['']]:[['89990000002','','Миша Б','Быков']]})};
  assert.throws(()=>x.assertReportDistributionRosterUnchanged_(sheet,[target],1), /REPORTS изменились/);
});


test('a body beginning with its own colon heading keeps the same ownership fingerprint', () => {
  const x = api(); const f = ownershipFixture(x);
  const target = child(x, 'Миша Б', 'Быков', '89990000001'); target.index = 0;
  const body = 'Настроение: описание. Аппетит: описание.';
  assert.ok(f.distribute('Миша Б — '+body, [target], false, ['Миша: '+body]).byRow[0]);
  assert.equal(x.rawReportRowOwnershipAllows_('evening', ['89990000001','','Миша Б','Быков','','Миша: '+body]), true);
});


test('re-admission under the same phone and full name does not inherit the old admission report', () => {
  const x = api(); const f = ownershipFixture(x);
  const target = child(x, 'Миша Б', 'Быков', '89990000001'); target.index = 0;
  const raw = 'Миша Б — Прошлое поступление.';
  f.props.set('REPORT_ADMISSION_9990000001', 'first-admission');
  assert.ok(f.distribute(raw,[target],true).byRow[0]);
  f.props.set('REPORT_ADMISSION_9990000001', 'second-admission');
  assert.equal(f.distribute(raw,[target],false).byRow[0], undefined);
  assert.equal(x.rawReportRowOwnershipAllows_('evening',['89990000001','','Миша Б','Быков','','Миша: Прошлое поступление.']),false);
});


test('ownership guards share one Properties read per execution instead of one per block/contact', () => {
  const x = api(); const f = ownershipFixture(x); let reads = 0;
  x.PropertiesService = {getScriptProperties:()=>({
    getProperties:()=>{reads++;return Object.fromEntries(f.props);},
    getProperty:key=>f.props.get(key)||'',setProperty:(key,value)=>f.props.set(key,value)
  })};
  const target = child(x, 'Миша Б', 'Быков', '89990000001'); target.index=0;
  for(let i=0;i<20;i++) f.distribute('Миша Б — Текст номер '+i+'.',[target],true);
  assert.equal(reads,1);
});

test('publication refuses a known foreign block before overwriting the raw source', () => {
  const x = api([['Саша','Александр, Александра']]); const f=ownershipFixture(x);
  const girl=child(x,'Саша Б','Бурова','89990000001');girl.index=0;
  const boy=child(x,'Саша Б','Березкин','89990000002');boy.index=0;
  const old='Саша Б — Синтетический текст прежнего ребёнка.';
  f.distribute(old,[girl],true);
  x.buildReportValidationChildren_=()=>[boy];
  x.LockService={getUserLock:()=>({waitLock(){},releaseLock(){}})};
  let value='Current valid source';
  const cell={getValue:()=>value,setValue:next=>{value=next}};
  assert.throws(()=>x.saveRawReportPublication_('evening',cell,old,Date.now(),undefined,old), /Отчёт не сохранён/);
  assert.equal(value,'Current valid source');
});

test('parent snapshot used by current reports and history cannot expose a mismatched owner', () => {
  const x=api(); const f=ownershipFixture(x);
  const original=child(x,'Миша Б','Быков','89990000001');original.index=0;
  f.distribute('Миша Б — Проверочный текст.',[original],true);
  const wrong=['89990000002','','Миша Б','Быков','','Миша: Проверочный текст.'];
  const snapshot=x.buildParentReportSnapshot_('89990000002','evening',false,[wrong]);
  assert.equal(snapshot.hasReport,false);
  assert.equal(snapshot.text,'');
});
