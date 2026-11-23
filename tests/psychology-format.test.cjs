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


test('free-form group report keeps topic, goal, chronology, participant observations and outcome in separate categories',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const f=window.MedsiPsychologyFormatter;
 // Entirely fictional prose. Never put real patient reports or identities in Git.
 const note=[
  'Отчёт о проведении группового психотерапевтического занятия с подростками',
  'Тема занятия: «Планирование учебного проекта». Цель занятия: обсудить этапы проекта и способы работы в команде.',
  'Занятие началось с знакомства. Затем участники оценили настроение по шкале. Далее обсудили варианты решения задач. После возвращения в общий круг выбрали шаги на следующую встречу.',
  'В ходе занятия наиболее активными были Участник А и Участница Б; Участник В слушал и отвечал на вопросы.',
  'Все молодцы, группе удалось завершить упражнение!'
 ].join('\n\n');
 for(const value of [note,note.replace(/\n\n/g,'\n'),note.replace(/\n\n/g,' ')]){
  const result=f.parse(value);
  assert.deepEqual(Array.from(result.meta.map(x=>x.title)),[
   'Описание занятия','Тема групповой психотерапии','Цель групповой психотерапии'
  ]);
  assert.deepEqual(Array.from(result.sections.map(x=>x.title)),[
   'Ход занятия','Наблюдения за участниками','Итоги'
  ]);
  const all=[
   ...result.meta.map(x=>x.body),
   ...result.sections.flatMap(x=>x.parts.flatMap(p=>p.type==='list'?p.items:[p.text||''])),
   ...result.tail.map(p=>p.text||'')
  ].join(' ');
  for(const phrase of [
   'Отчёт о проведении группового психотерапевтического занятия с подростками',
   '«Планирование учебного проекта»','обсудить этапы проекта',
   'Занятие началось с знакомства.','Затем участники оценили настроение',
   'После возвращения в общий круг','Участница Б; Участник В слушал',
   'Все молодцы, группе удалось завершить упражнение!'
  ]){
   assert.ok(all.toLocaleLowerCase('ru').includes(phrase.toLocaleLowerCase('ru')),phrase);
   assert.equal(all.toLocaleLowerCase('ru').split(phrase.toLocaleLowerCase('ru')).length-1,1,'A source phrase must not be duplicated');
  }
 }
});

test('alternative headings and unlabelled paragraphs remain safe and readable',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const f=window.MedsiPsychologyFormatter;
 const text=[
   'Тема занятия: Командное взаимодействие.',
   'Цель занятия: Научиться обсуждать разные решения.',
   'В начале встречи состоялось знакомство. Потом участники придумали варианты.',
   'Некоторые участники предложили альтернативные способы.',
   'По итогам занятия группа выбрала следующее упражнение.'
 ].join('\n\n');
 const result=f.parse(text);
 assert.deepEqual(Array.from(result.meta.map(x=>x.title)),[
  'Тема групповой психотерапии','Цель групповой психотерапии'
 ]);
 assert.deepEqual(Array.from(result.sections.map(x=>x.title)),[
  'Ход занятия','Наблюдения за участниками','Итоги'
 ]);
 const unclassified=f.parse('Тема занятия: Любая тема.\n\nПроизвольный текст без явных маркеров и наблюдений.');
 assert.equal(unclassified.meta.length,1);
 assert.equal(unclassified.sections.length,0,'Ambiguous prose cannot be assigned a clinical category');
 assert.equal(unclassified.tail[0].text,'Произвольный текст без явных маркеров и наблюдений.');
});


test('narrative participant notes follow activity, never swallow the introduction',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const node=tag=>({
   tag,className:'',textContent:'',children:[],
   append(...items){this.children.push(...items)},
   appendChild(item){this.children.push(item);return item},
   replaceChildren(...items){this.children=[...items]}
 });
 const document={
   readyState:'loading',addEventListener(){},createElement:node
 };
 const window={};
 vm.runInNewContext(source,{window,document});
 const format=window.MedsiPsychologyFormatter;
 // All names and content in this fixture are fictional.
 const fragments=[
  'Отчёт по групповой психотерапии с подростками',
  'Темой занятия стали способы договариваться о правилах. Цель встречи состояла в обсуждении личных границ.',
  'Содержательная часть занятия началась с работы в малых группах.',
  'Далее участники нарисовали собственные схемы. В конце были сделаны общие выводы.',
  'По участникам: наиболее активными были Участник А и Участница Б; Участник В отвечал по запросу.',
  'Все молодцы, группа прошла продуктивно!'
 ];
 for(const value of [fragments.join('\n\n'),fragments.join(' ')]){
  const parsed=format.parse(value);
  assert.deepEqual(Array.from(parsed.sections.map(item=>item.title)),
    ['Ход занятия','Наблюдения за участниками','Итоги']);
  assert.ok(parsed.preface&&parsed.preface.length>0,'Intro must be preserved before numbered stages');
  assert.equal(parsed.tail.length,0,'No leftover introductory text may be placed below conclusions');
  const contents=[
   ...parsed.preface.map(part=>part.text),
   ...parsed.sections.flatMap(section=>section.parts.map(part=>part.text))
  ].join(' ');
  let cursor=-1;
  for(const fragment of fragments){
   const start=contents.toLocaleLowerCase('ru').indexOf(fragment.toLocaleLowerCase('ru'));
   assert.ok(start>cursor,fragment+' must appear once in source order');
   assert.equal(contents.toLocaleLowerCase('ru').split(fragment.toLocaleLowerCase('ru')).length-1,1);
   cursor=start;
  }
  const container=node('main');
  assert.equal(format.render(container,value),true);
  const root=container.children[0];
  assert.deepEqual(root.children.map(child=>child.className),['psych-preface','psych-flow']);
  const flow=root.children[1];
  assert.deepEqual(flow.children.map(step=>step.children[1].children[0].textContent),
   ['Ход занятия','Наблюдения за участниками','Итоги']);
  const introText=root.children[0].children.map(child=>child.textContent).join(' ');
  assert.match(introText,/Темой занятия стали/);
  const observer=flow.children[1].children[1];
  assert.match(observer.children[1].textContent,/Участник А и Участница Б/);
 }
});

test('existing explicitly headed therapy sections stay intact and do not steal participant notes',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const format=window.MedsiPsychologyFormatter;
 const report=[
  'Тема: Работа в команде',
  'Основная часть: Участники обсуждали задание.',
  'По участникам: Участник А объяснял свои решения; Участник Б слушал.',
  'Все молодцы, занятие завершено.'
 ].join('\n\n');
 const parsed=format.parse(report);
 assert.deepEqual(Array.from(parsed.sections.map(section=>section.title)),
  ['Основная часть','Наблюдения за участниками','Итоги']);
 const body=parsed.sections.flatMap(section=>section.parts.map(part=>part.text||'')).join(' ');
 assert.match(body,/Участник А объяснял/);
 assert.match(body,/Все молодцы/);
});
