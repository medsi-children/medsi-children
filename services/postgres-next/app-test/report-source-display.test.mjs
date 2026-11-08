import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalEducatorSource} from '../app/report-source-display.mjs';

const children=[
  {child_id:'child_old',registered_first_name:'Арина',surname:'Алексеева'},
  {child_id:'child_new',registered_first_name:'Арина',surname:'Ахметова'},
  {child_id:'child_other',registered_first_name:'Михаил',surname:'Казьмин'}
];
const admissions=[
  {admission_id:'admission_old',child_id:'child_old',status:'active'},
  {admission_id:'admission_new',child_id:'child_new',status:'active'},
  {admission_id:'admission_other',child_id:'child_other',status:'active'}
];
function options(overrides={}) {
  return {
    kind:'morning',children,admissions,
    normalizedText:'Арина А. — Утром готовила проект.\nМиша К. — Смотрел фильм.',
    historyRows:[
      {kind:'morning',admission_id:'admission_old',text:'Арина: Утром готовила проект.'},
      {kind:'morning',admission_id:'admission_other',text:'Михаил: Смотрел фильм.'}
    ],
    nameVariants:[{preferred_name:'Михаил',variants_json:'["Миша","Мишенька"]'},
      {preferred_name:'Арина',variants_json:'[]'}],
    ...overrides
  };
}

test('on adding a namesake, an old report is relabelled by its proven admission, not the newest child',()=>{
  const display=canonicalEducatorSource(options());
  assert.equal(display,'Арина Ал — Утром готовила проект.\nМихаил К. — Смотрел фильм.');
  assert.doesNotMatch(display,/Арина Ах/);
});

test('same first two letters expand to the shortest unique surname prefix',()=>{
  const updated=children.map(c=>c.child_id==='child_new'?{...c,surname:'Алиева'}:c);
  assert.match(canonicalEducatorSource(options({children:updated})),/^Арина Але —/);
});
test('different surname initials remain a single initial',()=>{
  const updated=children.map(c=>c.child_id==='child_new'?{...c,surname:'Хмелева'}:c);
  assert.match(canonicalEducatorSource(options({children:updated})),/^Арина А\. —/);
});
test('unproven assignments, conflicting names and repeated text never get attributed to a child',()=>{
  const source=options();
  assert.equal(canonicalEducatorSource({...source,historyRows:[]}),source.normalizedText);
  const collision=canonicalEducatorSource({...source,historyRows:[
    ...source.historyRows,
    {kind:'morning',admission_id:'admission_new',text:'Арина: Утром готовила проект.'}
  ]});
  assert.match(collision,/^Арина А\. — Утром готовила проект\./);
  assert.match(collision,/\nМихаил К\. — Смотрел фильм\.$/);
  assert.match(canonicalEducatorSource({...source,normalizedText:'Арина Х. — Утром готовила проект.'}),
    /^Арина Х\. — Утром готовила проект\.$/);
});
test('same full name and surname is not guessed from arbitrary admission ordering',()=>{
  const duplicate=children.map(c=>c.child_id==='child_new'?{...c,surname:'Алексеева'}:c);
  const display=canonicalEducatorSource(options({children:duplicate}));
  assert.match(display,/^Арина А\. — Утром готовила проект\./);
  assert.match(display,/\nМихаил К\. — Смотрел фильм\.$/);
});
test('a sibling discharged after the publication still retains a unique historical identity',()=>{
  const oldAdmissions=admissions.map(a=>a.admission_id==='admission_old'?{...a,status:'closed'}:a);
  assert.match(canonicalEducatorSource(options({admissions:oldAdmissions})),/^Арина Ал —/);
});
test('therapy is not modified by child source heading logic',()=>{
  const input=options({kind:'psychology',normalizedText:'Общее занятие по когнитивной терапии.'});
  assert.equal(canonicalEducatorSource(input),input.normalizedText);
});


test('lowercase preferred names in variants always display with an uppercase initial',()=>{
  const data=options({
    nameVariants:[
      {preferred_name:'михаил',variants_json:'["миша","мишенька"]'},
      {preferred_name:'арина',variants_json:'[]'}
    ],
    normalizedText:'арина А. — Утром готовила проект.\nмиша К. — Смотрел фильм.'
  });
  const text=canonicalEducatorSource(data);
  assert.equal(text,'Арина Ал — Утром готовила проект.\nМихаил К. — Смотрел фильм.');
  assert.doesNotMatch(text,/(?:^|\n)(?:арина|михаил|миша)/);
});

test('even without historical ownership evidence, known first-name headers are capitalized without guessing identities',()=>{
  const data=options({
    historyRows:[],
    normalizedText:'арина А. — Утром готовила проект.\nмиша К. — Смотрел фильм.\nобщий комментарий: Сохранить нижний регистр.'
  });
  assert.equal(canonicalEducatorSource(data),
    'Арина А. — Утром готовила проект.\nМиша К. — Смотрел фильм.\nобщий комментарий: Сохранить нижний регистр.');
});

test('canonical source representation never mutates a parent report or group therapy source',()=>{
  const opts=options({nameVariants:[{preferred_name:'миша',variants_json:'["Михаил"]'}]});
  const before=JSON.stringify(opts.historyRows);
  canonicalEducatorSource(opts);
  assert.equal(JSON.stringify(opts.historyRows),before);
  assert.equal(canonicalEducatorSource({...opts,kind:'psychology',normalizedText:'миша: Групповая терапия.'}),
    'миша: Групповая терапия.');
});
