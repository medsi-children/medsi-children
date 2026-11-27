const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('parent assistant offers only for confident mapped topics and still skips urgent or uncertain messages', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  const anchor = '  window.MedsiParentChatScreen={open,close,refresh};';
  assert.ok(source.includes(anchor));
  const instrumented = source.replace(anchor, `window.__assistantIntent=assistantIntent;${anchor}`);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { classList:{add(){},remove(){},toggle(){},contains(){return false}} });
    return elements.get(id);
  };
  const window = {
    MedsiSmartBot: { analyze(text) {
      if (text.includes('medical symptom')) return {intent:{key:'medical'},confidence:.95};
      if (text.includes('human action')) return {intent:{key:'calls'},confidence:.95};
      if (text.includes('delivery status')) return {intent:{key:'delivery'},confidence:.95};
      if (text === 'report') return {intent:{key:'reportDelay',kind:'morning'},confidence:.95};
      if (text === 'medical') return {intent:{key:'medical'},confidence:.95};
      if (text === 'calls') return {intent:{key:'calls'},confidence:.95};
      return {intent:{key:'delivery'},confidence:.7};
    } },
    MedsiOverlayTransport: { sendMessage:async()=>({}) }, addEventListener() {}
  };
  const document = { getElementById:element, addEventListener(){}, body:{dataset:{screen:'screenChat'}} };
  const replyWindow = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'parents', 'smart-bot.js'), 'utf8'), { window: replyWindow });
  window.MedsiQuickReplies = replyWindow.MedsiQuickReplies;
  vm.runInNewContext(instrumented,{window,document,Intl,Date,setTimeout,clearTimeout});
  assert.equal(window.__assistantIntent('report').kind,'morning');
  assert.equal(window.__assistantIntent('medical').key,'medical');
  assert.equal(window.__assistantIntent('calls').key,'calls');
  assert.equal(window.__assistantIntent('у ребёнка температура и ему плохо medical symptom'),null);
  assert.equal(window.__assistantIntent('позвоните ребенку human action'),null);
  assert.equal(window.__assistantIntent('спасибо, доставку уже получили delivery status'),null);
  assert.equal(window.__assistantIntent('uncertain'),null);
});

test('doctor-directed answers reveal doctor contacts before asking whether the question was resolved', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  assert.match(source, /const DOCTOR_CONTACT_INTENTS=new Set\(\['meetings','meetTime','calls','payment','medical','medicine'\]\)/);
  assert.match(source, /assistantButton\('Контакты врача',\(\)=>\{body\.textContent=ASSISTANT_ANSWERS\.doctors;showResolutionActions\(\)\}\),assistantButton\('Да, вопрос решился'/);
  assert.match(source, /function showResolutionActions\(\)\{actions\.replaceChildren\(assistantButton\('Да, вопрос решился'/);
});

test('resolved parent questions close cleanly instead of asking to send them anyway', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  assert.match(source, /if\(resolved\)\{/);
  assert.match(source, /Хорошо, тогда вопрос воспитателям не отправляю\./);
  assert.doesNotMatch(source, /Всё ещё отправить вопрос воспитателям\?/);
});

test('report timing answers do not offer an unavailable report and explicit report requests ask which report to show', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  assert.ok(source.includes("reports:'Утренний отчёт с 15:00 до 16:00.\\nВечерний — с 21:00 до 22:00.'"));
  assert.ok(!source.includes("reports:'Утренний отчёт с 15:00 до 16:00.\\nВечерний — с 21:00 до 22:00.\\n\\nХотите посмотреть отчёт?'"));
  assert.match(source, /suggestion&&suggestion\.key==='reportRequest'&&!suggestion\.kind/);
  assert.match(source, /showReportKindChoices\('Какой отчёт показать\?'\)/);
  assert.match(source, /assistantButton\('Утренний отчёт'/);
  assert.match(source, /assistantButton\('Вечерний отчёт'/);
  assert.match(source, /history=\(await t\.request\(session,'\/lab\/report-history'\)\)\.reports\|\|\[\]/);
  assert.match(source, /Сегодняшний \$\{title\} отчёт пока не опубликован/);
  assert.doesNotMatch(source, /if\(found\)return found\.text/);
});

test('main parent blob follows the same conservative report flow', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parents', 'bot-chat-runtime.js'), 'utf8');
  assert.ok(source.includes("reports: { question: 'Когда ждать отчёт?', answer: 'Утренний отчёт с 15:00 до 16:00.\\nВечерний — с 21:00 до 22:00.', mood: 'neutral' }"));
  assert.doesNotMatch(source, /Когда ждать отчёт\?'[^\n]*Хотите посмотреть отчёт/);
  assert.match(source, /parsed\.key === 'reportRequest' && !kind/);
  assert.match(source, /Какой отчёт показать — утренний или вечерний\?/);
  assert.match(source, /Сейчас идёт окно публикации:/);
  assert.match(source, /Сегодняшний \$\{kind === 'morning' \? 'утренний' : 'вечерний'\} отчёт пока не опубликован/);
  assert.doesNotMatch(source, /Встречи с детьми проходят с 17:00 до 20:00\. Пожалуйста, согласуйте встречу/);
});

test('parent assistant uses the Medsi blob and existing report-delay wording, without snapshot-error copy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  assert.match(source, /src="\/parents\/blob\.webp"/);
  assert.match(source, /Сейчас идёт окно публикации:/);
  assert.match(source, /return quickReplies\.reportDelay;/);
  assert.match(source, /Вы про утренний отчёт или вечерний отчёт\?/);
  assert.doesNotMatch(source, /не могу (?:надёжно )?проверить|не смог проверить снимок публикации/);
  assert.match(source, /\/lab\/report-current/);
  assert.match(source, /\/lab\/report-history/);
});

test('the production parent chat now has the same tested assistant flow and styling', () => {
  const production = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  const experimental = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-ui.css'), 'utf8');
  // Production may include safety controls that are intentionally absent from
  // the isolated experiment, while retaining the same assistant behavior.
  assert.match(production, /if\(!isRetry&&assistantBypass!==text\)/);
  assert.match(production, /function showAssistantFollowup\(resolved\)/);
  assert.match(production, /if\(!state\.readOnly\)t\.markRead/);
  assert.match(production, /if\(!isRetry&&assistantBypass!==text\)/);
  assert.match(production, /function showAssistantFollowup\(resolved\)/);
  assert.match(styles, /\.parent-assistant-card\.is-compact\{/);
  assert.match(styles, /\.parent-assistant-card\.is-expanded\{/);
  assert.match(styles, /\.parent-assistant-card\.is-compact\{[^}]*width:max-content;[^}]*max-width:min\(292px/);
  assert.match(styles, /\.parent-assistant-card\.is-compact\{[^}]*left:max\(20px,env\(safe-area-inset-left\)\)/);
  assert.match(styles, /\.parent-assistant-card\.is-compact:after\{[^}]*border-radius:16px;/);
  assert.match(styles, /\.parent-assistant-card\.is-compact \.parent-assistant-actions\{[^}]*margin-top:0;[^}]*padding:3px 12px 10px/);
  assert.match(styles, /right:max\(12px,env\(safe-area-inset-right\)\)/);
  assert.match(production, /parent-assistant-card is-compact/);
});

test('parent and educator doctor contacts match the assistant and stay in one quick-reply button', () => {
  const parentTest = fs.readFileSync(path.join(__dirname, '..', 'parents', 'chat-screen.js'), 'utf8');
  const parentAssistant = fs.readFileSync(path.join(__dirname, '..', 'parents', 'bot-chat-runtime.js'), 'utf8');
  const educatorTest = fs.readFileSync(path.join(__dirname, '..', 'chat-overlay', 'educator-chat.js'), 'utf8');
  const sandbox = {window:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'parents', 'smart-bot.js'), 'utf8'), sandbox);
  const replies = sandbox.window.MedsiQuickReplies;
  assert.match(replies.doctors, /Контакты врачей/);
  assert.match(parentTest, /doctors:quickReplies\.doctors/);
  assert.match(parentAssistant, /DOCTOR_CONTACTS_TEXT = quickReplies\.doctors/);
  assert.match(educatorTest, /QUICK_REPLIES=window\.MedsiQuickReplies/);
  assert.match(parentTest, /groupTherapyParticipants:quickReplies\.groupTherapyParticipants/);
  assert.match(parentAssistant, /answer: quickReplies\.groupTherapyParticipants/);
  assert.match(educatorTest, /\['groupTherapyParticipants','Участники групповой терапии'/);
  assert.equal((educatorTest.match(/\['doctors','Контакты врачей'/g) || []).length, 1);
  assert.doesNotMatch(educatorTest, /\['(?:anastasia|anton)','/);
});
