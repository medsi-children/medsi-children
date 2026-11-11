const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validate} = require('../tutors/report-validation.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('service sections are rejected by their headings, independent of room labels', () => {
  for (const heading of [
    'Для врачей:', '❗Для врачей', '‼️ ДЛЯ ВРАЧЕЙ： служебный текст',
    '**Для врачей** — заметка', 'Для врача / заметка', 'Врачам...',
    'Общий комментарий:', '📋 ОБЩИЙ КОММЕНТАРИЙ — заметка',
    'Общие комментарии', 'Общий комментарий:: заметка'
  ]) {
    for (const prefix of ['', '501: ']) {
      const result = validate('evening', `${heading}\n${prefix}Лена — Основной текст.`);
      assert.equal(result.ok, false, heading);
      assert.equal(result.issues[0].reason, 'service_section');
    }
  }
});

test('doctor and comment phrases inside a child body are ordinary prose', () => {
  assert.equal(validate('morning',
    'Лена — Передала заметку для врачей. Это общий комментарий о занятии.').ok, true);
});


test('a pinned general note and the same child block are caught before submission', () => {
  const source = [
    '02.11 ВЕЧЕР',
    'Игры и общение',
    '',
    '📌Эрнест: Синтетический комментарий для персонала.',
    '',
    '📌У Лизы сегодня был разговор без отдельного заголовка.',
    '',
    '',
    'Эрнест: Основной детский блок.',
    'Лиза: Основной блок второго ребёнка.'
  ].join('\n');
  const result = validate('evening', source);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].reason, 'duplicate_name');
  assert.deepEqual(result.issues[0].lines, [4, 9]);
  assert.match(result.message, /Имя «Эрнест» повторяется/);
  assert.doesNotMatch(result.message, /строк[аи]?\s*\d/i);
  assert.match(result.message, /Удалите лишний блок или добавьте инициалы/);
});

test('decorative prefixes are accepted for distinct headers, not ordinary prose', () => {
  assert.equal(validate('evening',
    '📌Эрнест: Основной текст.\n\n📌У Лизы было мероприятие.\nЛиза: Другой детский блок.').ok, true);
  const response = validate('morning',
    '📌 Лена А.: Первый текст.\n\nЛена А. — Снова тот же ребёнок.');
  assert.equal(response.ok, false);
  assert.equal(response.issues[0].reason, 'duplicate_header');
  assert.match(response.message, /Уберите повтор или уточните фамилии/);
});

test('a single bare child name is allowed; bare duplicates are rejected', () => {
  assert.equal(validate('morning', 'Лена: Основной текст.').ok, true);
  const result = validate('morning', 'Лена — Первый текст.\nЛена: Второй текст.');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].reason, 'duplicate_name');
});

test('a bare name alongside an explicit initial requires an initial', () => {
  const result = validate('evening', 'Лена Т.: Первый текст.\nЛена — Второй текст.');
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].reason, 'missing_initial');
  assert.match(result.message, /без инициала/);
});

test('different initials distinguish namesakes', () => {
  assert.equal(validate('morning', 'Лена Т: Первый текст.\nЛена У. — Второй текст.').ok, true);
});

test('yo, case and initial dots cannot hide duplicate blocks', () => {
  assert.equal(validate('morning', 'Артём И.: Первый текст.\nАРТЕМ И — Второй текст.').ok, false);
  assert.equal(validate('morning', 'Артём: Первый текст.\nАртем — Второй текст.').ok, false);
});

test('popular alternative forms require distinct initials and never rename the source', () => {
  for (const [first, second] of [['Александр','Александра'], ['Саша','Александр'], ['Вова','Владимир'], ['Варя','Варвара']]) {
    const text = `${first}: Первый текст.\n${second} — Второй текст.`;
    const result = validate('evening', text);
    assert.equal(result.ok, false);
    assert.match(result.message, /похожие имена/);
    assert.equal(validate('evening', `${first} Т.: Первый текст.\n${second} У.: Второй текст.`).ok, true);
  }
});

test('distinct unfamiliar names are not merged by fuzzy matching', () => {
  assert.equal(validate('evening', 'Дарья: Первый текст.\nДарина: Второй текст.').ok, true);
});

test('a surname may distinguish equal initials, while its initial alone cannot', () => {
  assert.equal(validate('evening', 'Кирилл Широков: Первый текст.\nКирилл Шестаков: Второй текст.').ok, true);
  assert.equal(validate('evening', 'Кирилл Ш.: Первый текст.\nКирилл Широков: Второй текст.').ok, false);
});

test('preamble, room labels, dates and author lines do not interfere with child blocks', () => {
  const text = [
    '09.10.2026 г. Утро — день', 'Игры 🎲', 'Общение 💬',
    'Поступление:', '508 Новый ребёнок, 16 лет',
    'Отчёт составили: Тестовый автор', '501',
    'Лена Т.: Основной текст в 17:00, число 1,5.',
    'Палата № 502: Маша — Второй текст.',
    '503 / Лена У — Третий текст.'
  ].join('\n');
  const result = validate('morning', text);
  assert.equal(result.ok, true);
  assert.equal(result.checkedBlocks, 3);
});

test('bare names at the beginning of body lines do not become headers', () => {
  const text = 'Лена — Основной текст.\nМаша говорила о занятии.\nЛена потом пошла на прогулку.';
  assert.equal(validate('evening', text).ok, true);
  assert.equal(validate('evening', text).checkedBlocks, 1);
});

test('empty reports and reports without any formatted child block are rejected', () => {
  assert.equal(validate('morning', ' ').ok, false);
  assert.equal(validate('morning', '09.10 вечер\nИгры\nОтчёт составили: Тестовые авторы').ok, false);
});

test('psychology reports do not use the child header rules', () => {
  assert.equal(validate('psychology', 'Общий комментарий: Синтетический текст.').ok, true);
});

test('report form keeps invalid text and shows success only after queue receipt', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value:'', textContent:'', disabled:false, dataset:{}, handlers:{},
        classList:{add:name=>classes.add(name), remove:name=>classes.delete(name),
          toggle:(name,on)=>on?classes.add(name):classes.delete(name), contains:name=>classes.has(name)},
        addEventListener(event, handler) {this.handlers[event] = handler;}
      });
    }
    return elements.get(id);
  };
  let release;
  const received = new Promise(resolve => {release = resolve;});
  const queued = [];
  const transport = {chats:async()=>({chats:[]}), reportSubmit:async(_session,payload)=>{
    queued.push(payload); await received; return {ok:true,accepted:true,submissionId:payload.submissionId};
  }};
  const storage = {
    medsi_tutor_session_v1:'synthetic-token',
    medsi_d1_educator_session_v1:JSON.stringify({token:'synthetic-session',expiresAt:Date.now()+3600000})
  };
  const context = {
    window:{MedsiReportValidation:{validate}, MedsiOverlayTransport:transport,
      MedsiReportClarifier:{prepare:async()=>({clarification:null,deletions:[]}),finish:async()=>''}, scrollTo(){}},
    document:{getElementById:element, body:{dataset:{started:'1'}}},
    MedsiOverlayTransport:transport, localStorage:{getItem:key=>storage[key],setItem(){},removeItem(){}},
    setTimeout:()=>1, clearTimeout(){}, console,
    fetch:()=>{throw new Error('Unexpected Apps Script request');}
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../tutors/full-web.js'), 'utf8'), context);
  element('btnMorning').handlers.click();
  const invalid = 'Для врачей:\nЛена — Синтетическая заметка.';
  element('text').value = invalid;
  await element('btnSend').handlers.click();
  assert.equal(element('reportError').textContent, 'Найден блок для врачей, пожалуйста, удалите его.');
  assert.equal(element('text').value, invalid);
  assert.equal(context.document.body.dataset.screen, 'report-morning');
  assert.equal(queued.length, 0);

  // An emoji-prefixed staff note followed by a true child section must
  // be blocked locally, even if there is no "Для врачей" heading.
  const duplicated = '📌Лена: Синтетический комментарий.\n\nЛена: Основной блок.';
  element('text').value = duplicated;
  await element('btnSend').handlers.click();
  assert.equal(queued.length, 0);
  assert.equal(element('text').value, duplicated);
  assert.match(element('reportError').textContent, /Имя «Лена» повторяется/);
  assert.equal(element('reportError').classList.contains('report-validation-warning'), true);

  const valid = 'Лена — Основной текст.';
  element('text').value = valid;
  const sending = element('btnSend').handlers.click();
  assert.equal(context.document.body.dataset.screen, 'report-morning');
  assert.equal(element('btnSend').disabled, true);
  for(let i=0;i<12&&!queued.length;i++)await Promise.resolve();
  assert.equal(queued[0].text, valid);
  release(); await sending;
  assert.equal(context.document.body.dataset.screen, 'screenDone');
  assert.equal(element('btnSend').disabled, false);
});

test('queue failure never falls back to Apps Script or returns a success receipt', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../tutors/full-web.js'), 'utf8');
  const submit = source.slice(source.indexOf('  async function submitReportPayload('), source.indexOf('  async function sendReport('));
  const transport={reportSubmit:async()=>{throw Object.assign(new Error('Connection lost'),{code:'NETWORK'});}};
  const context = {
    tutorToken:'synthetic', window:{MedsiReportValidation:{validate},MedsiOverlayTransport:transport,
      MedsiReportClarifier:{prepare:async()=>({clarification:null,deletions:[]}),finish:async()=>''}},
    MedsiOverlayTransport:transport, ensureD1Fresh:async()=>({token:'synthetic'}),
    callApi:()=>{throw new Error('Unexpected Apps Script request');}
  };
  vm.createContext(context); vm.runInContext(submit, context);
  await assert.rejects(context.submitReportPayload('morning','Лена — Основной текст.','report_synthetic_timeout'),/Connection lost/);
  transport.reportSubmit=async()=>({ok:true,accepted:true,submissionId:'report_other'});
  await assert.rejects(context.submitReportPayload('morning','Лена — Основной текст.','report_synthetic_timeout'),/подтвердить сохранение/);
});

test('manual retry reuses an uncertain submission id and preserves form text', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../tutors/full-web.js'),'utf8');
  const send=source.slice(source.indexOf('  async function sendReport('),source.indexOf('  function showReportSent('));
  const elements={btnSend:{dataset:{type:'morning'},disabled:false},text:{value:'Лена — Основной текст.'},reportError:{classList:{add(){},remove(){},toggle(){}}}};
  const ids=[];let errors=0,successes=0,nextId=0;
  const context={$:id=>elements[id],reportAttempt:null,reportSubmissionId:()=>`report_synthetic_${++nextId}`,
    submitReportPayload:async(_kind,_text,id)=>{ids.push(id);if(ids.length===1)throw Object.assign(new Error('Network failed'),{code:'NETWORK'});},
    showReportError:()=>{errors++;},showReportSent:()=>{successes++;}};
  vm.createContext(context);vm.runInContext(send,context);
  await context.sendReport();
  assert.equal(errors,1);assert.equal(successes,0);assert.equal(elements.text.value,'Лена — Основной текст.');
  await context.sendReport();
  assert.equal(ids[0],ids[1]);assert.equal(successes,1);
  await context.sendReport();
  assert.notEqual(ids[1],ids[2]);
});
