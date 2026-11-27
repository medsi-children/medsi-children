import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../parents/smart-bot.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
runInNewContext(source, sandbox);
const bot = sandbox.window.MedsiSmartBot;
const key = result => typeof result === 'string' ? result : result && result.key;

const cases = [
  ["почему про моего ребенка не написано в отчете по групповой терапии","groupTherapyParticipants"],
  ["почему про мою дочь не написали в отчёте по групповой психотерапии","groupTherapyParticipants"],
  ["почему его не описывают","groupTherapyParticipants"],
  ["ребенка нету в списке","groupTherapyParticipants"],
  ["в отчёте по групповой психотерапии не упомянули имя моего сына","groupTherapyParticipants"],
  ["почему в отчете групповой терапии нет моего ребенка","groupTherapyParticipants"],
  ["покажи отчет по групповой психотерапии","groupTherapy"],
  ["почему ребёнок не ходил на групповую психотерапию","groupTherapy"],
  ["почему нет отчета по групповой психотерапии","groupTherapy"],
  ["что можно писать воспитателям в чат","writeTopic"],
  ['почему нету отчета', 'reportDelay'],
  ['вечерний ещё не пришёл', 'reportDelay'],
  ['утреннего отчёта до сих пор нет', 'reportDelay'],
  ['утренний опаздывает', 'reportDelay'],
  ['когда будет утренний отчёт', 'reports'],
  ['пришлите последний отчёт', 'reportRequest'],
  ['почему в отчёте написано про лекарства', 'medical'],
  ['спасибо за отчёт', 'thanks'],
  ['как заказать доставку еды ребёнку', 'delivery'],
  ['можно ли привезти таблетки ребёнку', 'delivery'],
  ['когда я могу встретиться с ребёнком', 'meetTime'],
  ['номер лечащего врача', 'doctors'],
  ['во сколько групповая психотерапия', 'groupTherapyTime'],
  ['индивидуальные занятия с психологом', 'individualTherapy'],
  ['как оплатить лечение', 'payment'],
  ['привет, где отчёт', 'reportDelay']
];
for (const [question, expected] of cases) {
  assert.equal(key(bot.classify(question)), expected, question);
}

for (const greeting of ['приветики', 'здарова', 'здрасьте', 'добрый день', 'доброго времени суток', 'приветик, Медси Бот', 'hello']) {
  assert.equal(bot.isGreetingOnly(greeting), true, greeting);
}
for (const question of ['привет, где отчёт?', 'приветствие в отчёте', 'добрый день, когда встреча с ребёнком?']) {
  assert.equal(bot.isGreetingOnly(question), false, question);
}
const replies = sandbox.window.MedsiQuickReplies;
assert.equal(Object.keys(replies).length, 10);
assert.equal(replies.groupTherapyParticipants, "Уважаемые родители! 🩵\n\nЕсли имя вашего ребёнка не упомянуто в отчёте о групповой психотерапии, это не означает, что он пропустил занятие.\n\nПсихологи обычно отмечают наиболее активных участников. Групповую терапию посещают все дети, за исключением особых случаев.\n\nИнформацию об участии в терапии или её пропуске мы также стараемся указывать в дневных отчётах.\n\nБлагодарим за понимание! 🙏");
assert.ok(replies.reportDelay.includes('Пожалуйста, наберитесь терпения.'));
assert.doesNotMatch(replies.reportDelay, /ближайшие часы|напишите нам в чате/);
console.log('✓ Распознавание Медси Бота и быстрые ответы');
