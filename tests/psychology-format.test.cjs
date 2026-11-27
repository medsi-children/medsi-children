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


test('long quoted therapy topic uses full-width content and preserves activity chronology',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const node=tag=>({
  tag,className:'',textContent:'',children:[],
  append(...items){this.children.push(...items)},
  appendChild(item){this.children.push(item);return item},
  replaceChildren(...items){this.children=[...items]}
 });
 const window={};
 const document={readyState:'loading',addEventListener(){},createElement:node};
 vm.runInNewContext(source,{window,document});
 const formatter=window.MedsiPsychologyFormatter;
 // Entirely fictional group session, with the same structural problem as a
 // prose-heavy topic field: test data must never contain real patient notes.
 const phrases=[
  'Вначале занятия участники оценили настроение по шкале.',
  'Затем разминка: участники отвечали на нейтральные вопросы.',
  'Далее обсуждение того, что помогает услышать другого.',
  'Практическое задание: придумать три поддерживающие фразы.',
  'Далее обсуждение примеров.',
  'Активно участвовали Участник А и Участник Б. Участник В задавал уточняющие вопросы.',
  'В конце занятия дали задание вести заметки.',
  'Группа прошла спокойно.'
 ];
 const raw='Тема групповой психотерапии: "Навыки конструктивного диалога". '+phrases.join(' ');
 const parsed=formatter.parse(raw);
 assert.deepEqual(Array.from(parsed.meta.map(item=>item.title)),['Тема групповой психотерапии']);
 assert.equal(parsed.meta[0].body,'"Навыки конструктивного диалога"');
 assert.deepEqual(Array.from(parsed.sections.map(step=>step.title)),[
  'Начало занятия','Разминка','Обсуждение','Практическая часть',
  'Обсуждение','Наблюдения за участниками','Завершение','Итоги'
 ]);
 const body=parsed.sections.flatMap(step=>step.parts.map(part=>part.text||'')).join(' ');
 for(const phrase of phrases){
  assert.ok(body.includes(phrase),phrase);
  assert.equal(body.split(phrase).length-1,1,'Each synthetic source sentence must appear once');
 }
 const container=node('div');
 assert.equal(formatter.render(container,raw),true);
 const root=container.children[0];
 assert.equal(root.children[0].className,'psych-intro');
 const introRow=root.children[0].children[0];
 assert.equal(introRow.children[0].textContent,'Тема групповой психотерапии');
 assert.equal(introRow.children[1].textContent,'"Навыки конструктивного диалога"');
 assert.equal(root.children[1].className,'psych-flow');
 const css=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.css'),'utf8');
 assert.match(css,/\.psych-intro-row\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
 assert.doesNotMatch(css,/\.psych-intro-row\{[^}]*grid-template-columns:minmax\(180px/);
 assert.match(css,/\.psych-intro-value\{[^}]*overflow-wrap:break-word/);
});

test('ambiguous therapy prose stays untouched rather than inventing stages',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const format=window.MedsiPsychologyFormatter;
 const short='Тема: "Общение". Вначале занятия участники поделились мыслями.';
 const parsed=format.parse(short);
 assert.equal(parsed.meta.length,1);
 assert.equal(parsed.meta[0].body,'"Общение". Вначале занятия участники поделились мыслями.');
 assert.equal(parsed.sections.length,0);
 const unquoted='Тема: Сотрудничество. На занятии ребята обсуждали правила взаимодействия.';
 const free=format.parse(unquoted);
 assert.equal(free.meta[0].body,'Сотрудничество. На занятии ребята обсуждали правила взаимодействия.');
 assert.equal(free.sections.length,0);
});

test('therapy stylesheet and script refresh in both parent report and assistant shadow root',()=>{
 const read=relative=>fs.readFileSync(path.join(__dirname,'..',relative),'utf8');
 const main=read('index.html'),assistant=read('parents/smart-bot-widget.js');
 const version='20261127-therapy-compact-3';
 for(const markup of [main,assistant]){
  assert.ok(markup.includes('/parents/psychology-format.js?v='+version));
  assert.ok(markup.includes('/parents/psychology-format.css?v='+version));
 }
});



test('therapy stays a clean structured card without an original-source button',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
  const make=tag=>({tag,className:'',textContent:'',children:[],
    append(...parts){this.children.push(...parts)},
    appendChild(item){this.children.push(item);return item},
    replaceChildren(...parts){this.children=[...parts]}
  });
  const document={readyState:'loading',addEventListener(){},createElement:make};
  const window={};
  vm.runInNewContext(source,{window,document});
  const f=window.MedsiPsychologyFormatter;
  // Fictional people and group activities only.
  const phrases=[
    'Вначале занятия участники обсудили план.',
    'Затем разминка: придумали персонажей.',
    'Далее обсуждение новых вариантов.',
    'Практическое задание: собрать общий макет.',
    'Далее обсуждение.',
    'Активно участвовали Участник А и Участник Б.',
    'В конце занятия подвели итоги.',
    'Группа прошла спокойно.'
  ];
  const text='Тема групповой психотерапии: "Совместный проект". '+phrases.join(' ');
  const parsed=f.parse(text);
  assert.equal(f.losslessView(text,parsed),true);
  assert.deepEqual(Array.from(parsed.sections.map(item=>item.title)),[
    'Начало занятия','Разминка','Обсуждение','Практическая часть',
    'Наблюдения за участниками','Завершение','Итоги'
  ]);
  const practical=parsed.sections.find(item=>item.title==='Практическая часть');
  assert.equal(practical.parts.length,1,
    'A short transition must not create a separated paragraph below the task');
  assert.equal(practical.parts[0].text,
    'Практическое задание: собрать общий макет. Далее обсуждение.');
  const result=make('div');
  assert.equal(f.render(result,text),true);
  const root=result.children[0];
  assert.equal(root.className,'psych-report');
  assert.deepEqual(Array.from(root.children.map(child=>child.className)),['psych-intro','psych-flow']);
  const practicalNode=root.children[1].children[3].children[1];
  assert.equal(practicalNode.children.length,2,'One heading and one uninterrupted paragraph');
  assert.equal(practicalNode.children[1].textContent,
    'Практическое задание: собрать общий макет. Далее обсуждение.');
  const body=parsed.sections.flatMap(item=>item.parts.map(part=>part.text||'')).join(' ');
  for(const phrase of phrases){
    assert.ok(body.includes(phrase),'Missing source sentence: '+phrase);
    assert.equal(body.split(phrase).length-1,1,'Do not duplicate the observation');
  }
  assert.doesNotMatch(source,/Показать полный исходный текст|showExactSource|addOriginalText/);
});

test('uncertain therapy parsing still renders an elegant complete report',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
  const make=tag=>({tag,className:'',textContent:'',children:[],
    append(...parts){this.children.push(...parts)},
    appendChild(item){this.children.push(item);return item},
    replaceChildren(...parts){this.children=[...parts]}
  });
  const doc={readyState:'loading',addEventListener(){},createElement:make};
  const window={};
  vm.runInNewContext(source,{window,document:doc});
  const f=window.MedsiPsychologyFormatter;
  const paragraphs=['Тема: Коллективное творчество.',
    'Отчёт о групповой психотерапии.',
    'Участник А предложил идею. Затем Участник Б добавил предложение.',
    'Итоговый макет собрали вместе.'];
  const input=paragraphs.join('\n\n');
  // The parser may recognize an ambiguous format conservatively, but it
  // must never expose a raw-source/debug control or drop participant details.
  assert.equal(f.losslessView(input,f.parse(input)),false,
    'The fixture must genuinely exercise conservative presentation');
  const node=make('div');
  assert.equal(f.render(node,input),true);
  const root=node.children[0];
  assert.equal(root.className,'psych-report psych-report-natural');
  assert.equal(root.children[0].className,'psych-intro');
  assert.equal(root.children[0].children[0].children[1].textContent,
    'Коллективное творчество.');
  const narrative=root.children[1];
  assert.equal(narrative.className,'psych-natural-body');
  const shown=narrative.children.map(item=>item.textContent).join(' ');
  for(const phrase of ['Участник А предложил идею.','Участник Б добавил предложение.','Итоговый макет собрали вместе.']){
    assert.ok(shown.includes(phrase),'Missing: '+phrase);
  }
  assert.equal(root.children.filter(c=>c.tag==='details').length,0);
  const css=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.css'),'utf8');
  assert.match(css,/\.psych-natural-body\{[^}]*min-width:0/);
  assert.doesNotMatch(css,/\.psych-source-details|\.psych-report-source-only/);
});

test('therapy formatting assets refresh in parent report and assistant',()=>{
  const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  for(const markup of [read('index.html'),read('parents/smart-bot-widget.js')]){
    assert.ok(markup.includes('/parents/psychology-format.js?v=20261127-therapy-compact-3'));
    assert.ok(markup.includes('/parents/psychology-format.css?v=20261127-therapy-compact-3'));
  }
});


test('therapy attendance notice is pink, readable and only shown for group therapy',()=>{
 const read=relative=>fs.readFileSync(path.join(__dirname,'..',relative),'utf8');
 const callbacks={};
 const classes=new Set();
 const banner={
  innerHTML:'',
  classList:{
   add(...names){for(const name of names)classes.add(name)},
   remove(...names){for(const name of names)classes.delete(name)},
   contains(name){return classes.has(name)}
  }
 };
 const document={
  getElementById(id){
   if(id==='reportDisclaimer')return banner;
   if(['btnMorning','btnEvening','btnPsychology'].includes(id))
     return {addEventListener(event,cb){assert.equal(event,'click');callbacks[id]=cb}};
   return null;
  }
 };
 vm.runInNewContext(read('parents/report-disclaimer.js'),{
  document,setTimeout:cb=>{cb();return 1}
 });
 assert.equal(typeof callbacks.btnPsychology,'function');
 callbacks.btnPsychology();
 const shown=banner.innerHTML;
 assert.ok(classes.has('report-disclaimer-psychology'));
 assert.equal((shown.match(/class="psychology-participation-notice"/g)||[]).length,1);
 for(const passage of [
  'Уважаемые родители!',
  'Если имя вашего ребёнка не упомянуто в отчёте о групповой психотерапии, это не означает, что он пропустил занятие.',
  'Психологи обычно отмечают наиболее активных участников. Групповую терапию посещают все дети, за исключением особых случаев.',
  'Информацию об участии в терапии или её пропуске мы также стараемся указывать в дневных отчётах.',
  'Благодарим за понимание!'
 ]){
  assert.ok(shown.includes(passage),'Missing approved text: '+passage);
 }
 for(const removed of ['<strong>Групповая психотерапия</strong>','Здесь вы можете прочесть отчёт с групповой психотерапии.','Отчёты об индивидуальной работе с вашим ребёнком вам предоставит ваш психолог.','chat-note-list']){
  assert.ok(!shown.includes(removed),'Removed introduction must not be shown: '+removed);
 }
 assert.doesNotMatch(shown,/\p{Extended_Pictographic}/u,'Notice must have no emoji');
 callbacks.btnPsychology();
 assert.equal(banner.innerHTML,shown,'The warning must not duplicate on reentry');
 for(const button of ['btnMorning','btnEvening']){
  callbacks[button]();
  assert.ok(!banner.innerHTML.includes('psychology-participation-notice'),
    button+' must not display the group therapy notice');
  assert.ok(!banner.innerHTML.includes('Уважаемые родители!'));
 }
 const css=read('parents/dashboard-ui.css');
 assert.match(css,/\.report-disclaimer-psychology \.psychology-participation-notice\{/);
 assert.match(css,/\.psychology-participation-lead\{/);
 assert.match(css,/@media\(max-width:560px\)/);
 assert.match(css,/\.report-disclaimer\.report-disclaimer-psychology\{[^}]*background:linear-gradient\(135deg,#f9a2c8 0%,#ed72a7 54%,#df5894 100%\);[^}]*color:#fff!important;[^}]*border-radius:18px;[^}]*padding:9px 11px;[^}]*font-size:\.80rem!important;[^}]*font-weight:650;[^}]*line-height:1\.32;/);
 assert.match(css,/\.psychology-participation-notice p\{[^}]*color:inherit;[^}]*font-weight:inherit;/);
 assert.match(css,/\.psychology-participation-notice>strong\{[^}]*color:inherit;[^}]*font-weight:bolder;/);
 assert.match(css,/\.report-disclaimer-psychology \.psychology-participation-notice\{[^}]*margin:0;[^}]*padding:0;[^}]*border:0;[^}]*background:transparent;/);
 const main=read('index.html');
 assert.ok(main.includes('/parents/dashboard-ui.css?v=20261128-rose-banner-2'));
 assert.ok(main.includes('/parents/report-disclaimer.js?v=20261128-group-therapy-heading-1'));
 assert.ok(main.includes('/parents/full-web.js?v=20261128-group-therapy-heading-1'));
 const app=read('parents/full-web.js');
 const titleSource=app.match(/function reportTitle\(kind\)\{[^}]*\}/)?.[0];
 assert.ok(titleSource);
 const title=vm.runInNewContext(titleSource+';reportTitle');
 assert.equal(title('psychology'),'Групповая терапия');
 assert.equal(title('morning'),'Утренний отчёт');
 assert.equal(title('evening'),'Вечерний отчёт');
});
