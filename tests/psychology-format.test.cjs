const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
test('psychotherapy formatter retains headings and bullet lists for unstructured reports',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const f=window.MedsiPsychologyFormatter;
 assert.ok(f);
 const parts=f.plainParts('Этап занятия:\n• Приветствие\n• Практическое упражнение');
 assert.deepEqual(Array.from(parts.map(p=>p.type)),['heading','list']);
 assert.equal(parts[1].items.length,2);
 const parsed=f.parse('Тема: Эмоции\n\n1. Разогрев: Назвали чувства');
 assert.equal(parsed.meta.length,1);
 assert.equal(parsed.sections.length,1);
});

test('psychotherapy narrative after the topic is divided into readable stages',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const f=window.MedsiPsychologyFormatter;
 const input='Тема групповой психотерапии: "Понятие и функции благодарности". Сначала оценили состояние по шкале. Затем провели разминку. Основная часть: Обсудили притчу. Затем выполнили практическое задание. Активно участвовали Арина и Егор. Групповое занятие в целом прошло продуктивно.\n\nОтчёт о групповой психотерапии';
 const parsed=f.parse(input);
 assert.equal(parsed.meta[0].body,'"Понятие и функции благодарности"');
 assert.ok(parsed.sections.some(s=>s.title==='Начало занятия'));
 assert.ok(parsed.sections.some(s=>s.title==='Разминка'));
 assert.ok(parsed.sections.some(s=>s.title==='Основная часть'));
 assert.ok(parsed.sections.some(s=>s.title==='Практическая часть'));
 assert.ok(parsed.sections.some(s=>s.title==='Наблюдения за участниками'));
 assert.ok(parsed.sections.some(s=>s.title==='Итоги'));
 assert.ok(!parsed.sections.some(s=>s.title==='Отчёт о групповой психотерапии'));
});


test('unlabelled CBT group narrative is divided into meaningful sections without rewriting observations',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const f=window.MedsiPsychologyFormatter;
 // Fictional fixture: no patient information is committed to source control.
 const narrative=[
  'Отчёт по групповой психотерапии',
  'Занятие было посвящено теме «Когнитивные ошибки» и их влиянию на эмоции. Цель занятия — освоить поиск альтернативных мыслей.',
  'Структура занятия включала знакомство и обсуждение модели КБТ. В практической части участники анализировали мысли и формулировали выводы.',
  'Первый участник выполнял упражнение; Второй участник слушал других; Третий участник задавал вопросы. В целом группа смогла сформулировать выводы.'
 ].join('\n\n');
 for(const value of [narrative,narrative.replace(/\n\n/g,'\n')]){
   const result=f.parse(value);
   assert.deepEqual(Array.from(result.meta.map(x=>x.title)),[
     'Тема групповой психотерапии','Цель групповой психотерапии'
   ]);
   assert.deepEqual(Array.from(result.sections.map(x=>x.title)),[
     'Ход занятия','Практическая часть','Наблюдения за участниками','Итоги'
   ]);
   const bodies=[...result.meta.map(x=>x.body),...result.sections.flatMap(x=>x.parts.map(p=>p.text||''))].join(' ');
   for(const phrase of [
     '«Когнитивные ошибки»','освоить поиск альтернативных мыслей',
     'знакомство и обсуждение модели КБТ','анализировали мысли',
     'Первый участник выполнял упражнение','Третий участник задавал вопросы',
     'В целом группа смогла сформулировать выводы'
   ]) assert.ok(bodies.includes(phrase),phrase);
   assert.equal((bodies.match(/Третий участник задавал вопросы/g)||[]).length,1);
   assert.doesNotMatch(bodies,/Отчёт по групповой психотерапии/);
 }
});

test('blank lines create real paragraphs; soft line wraps stay inside one paragraph',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const parts=window.MedsiPsychologyFormatter.plainParts('Первый абзац.\nПродолжение первого.\n\nВторой абзац.');
 assert.deepEqual(Array.from(parts.map(x=>x.type)),['p','p']);
 assert.equal(parts[0].text,'Первый абзац. Продолжение первого.');
 assert.equal(parts[1].text,'Второй абзац.');
 const css=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.css'),'utf8');
 assert.match(css,/\.psych-paragraph\{[^}]*white-space:pre-wrap/);
 assert.match(css,/\.psych-intro-value\{[^}]*white-space:pre-wrap/);
});
