import test from 'node:test';
import assert from 'node:assert/strict';
import {findPublishedSourceForChild as match,backfillRecentEducatorReports as backfill}
  from '../app/source-report-backfill.mjs';

const anna={child_id:'child_anna',registered_first_name:'Анна',surname:'Пономарёва'};
const misha={child_id:'child_misha',registered_first_name:'Михаил',surname:'Казьмин'};
const khalitova={child_id:'child_khal',registered_first_name:'Анюта',surname:'Халитова'};
const variants=[
  {preferred_name:'анна',variants_json:'["аня","анюта"]'},
  {preferred_name:'михаил',variants_json:'["миша"]'}
];
function find(source,child=anna,activeChildren=[anna,misha]){
  return match({normalizedText:source,child,activeChildren,nameVariants:variants});
}
test('one Аня in the staff morning source is assigned to sole canonical Анна',()=>{
  const text='Аня — ❗ 13 лет. Вернулась к нам.\nПродолжение наблюдения.\nМиша К. — Читал книгу.';
  assert.equal(find(text),'Аня: ❗ 13 лет. Вернулась к нам.\nПродолжение наблюдения.');
  assert.doesNotMatch(find(text),/Читал книгу/);
});
test('ambiguous namesakes without initials are NEVER assigned to either parent',()=>{
  const text='Аня — Утренние наблюдения.';
  assert.equal(find(text,anna,[anna,khalitova]),null);
  assert.equal(find(text,khalitova,[anna,khalitova]),null);
});
test('distinct initials distinguish namesakes; shared or unknown initials are blocked',()=>{
  const text='Аня П. — Текст для Анны.\nАнна Х. — Текст для Анюты.';
  assert.equal(find(text,anna,[anna,khalitova]),'Аня: Текст для Анны.');
  assert.equal(find(text,khalitova,[anna,khalitova]),'Анна: Текст для Анюты.');
  const sameInitial={...khalitova,surname:'Петрова'};
  assert.equal(find('Аня П. — Наблюдение.',anna,[anna,sameInitial]),null);
  assert.equal(find('Аня Х. — Наблюдение.',anna,[anna,khalitova]),null);
});
test('duplicate bare child headers are ambiguous; general comments do not attach to another child',()=>{
  assert.equal(find('Аня — Первое.\nАня — Второе.'),null);
  assert.equal(find('Аня — Первое.\nОбщий комментарий: Для врачей.'),'Аня: Первое.');
  assert.equal(find('Групповая терапия: Аня активна.'),null);
});

function fakeDatabase({source='Аня — Была на группе.\nМиша К. — Собирал пазл.',
  secondAnna=false,otherAdmission=false,expired=false}={}){
  const now=Date.parse('2026-11-08T13:00:00Z');
  const profiles=[{phone10:'9000000001',child_id:'child_anna',admission_id:'admission_anna'}];
  const admissions=[{admission_id:'admission_anna',child_id:'child_anna',status:'active'},
    {admission_id:'admission_misha',child_id:'child_misha',status:'active'}];
  const children=[anna,misha];
  if(secondAnna){children.push(khalitova);admissions.push({
    admission_id:'admission_khal',child_id:'child_khal',status:'active'
  })}
  const current=[],history=[],writes=[];
  if(otherAdmission)history.push({phone10:profiles[0].phone10,kind:'morning',
    report_date:'2026-11-08',admission_id:'old_admission'});
  const heads=[{kind:'morning',publication_id:'publication_morning'}];
  const raw={publication_id:'publication_morning',kind:'morning',
    report_date:'2026-11-08',revision:5n,submitted_at:BigInt(now-(expired?9:1)*86400000),
    normalized_text:source};
  const sql={begin:async(_opts,fn)=>{
    const tx=async(strings,...params)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.includes('FROM report_ownership'))return [[]];
      if(q.startsWith('SELECT phone10,child_id,admission_id FROM parent_profiles'))return [profiles];
      if(q.startsWith('SELECT admission_id,child_id,status FROM admissions'))return [admissions];
      if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [children];
      if(q.startsWith('SELECT phone10,kind,admission_id,text FROM parent_current_reports'))return [current];
      if(q.startsWith('SELECT kind,publication_id FROM report_publication_head'))return [heads];
      if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [variants];
      if(q.startsWith('SELECT publication_id,kind,report_date,submitted_at,')&&q.includes('FROM raw_reports'))return [[raw]];
      if(q.startsWith('SELECT admission_id FROM parent_report_history')){
        return [history.filter(h=>h.phone10===params[0]&&h.kind===params[1]&&h.report_date===params[2])];
      }
      throw new Error('Unexpected SQL '+q);
    };
    tx.upsert=async(strings,...params)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.includes('FROM report_ownership'))return [[]];
      if(q.startsWith('INSERT INTO parent_current_reports')){
        writes.push('current');
        current.splice(0,current.length,{phone10:params[0],kind:params[1],admission_id:params[2],
          publication_id:params[3],revision:params[4],text:params[5],version:params[6]});
      }else if(q.startsWith('INSERT INTO parent_report_history')){
        writes.push('history');
        history.push({phone10:params[0],kind:params[1],report_date:params[2],
          admission_id:params[3],text:params[6]});
      }else throw new Error('Unexpected write '+q);
      return [[]];
    };
    return fn(tx);
  }};
  return {sql,current,history,writes,now,raw};
}

test('late linked parent receives current morning source in PostgreSQL exactly once',async()=>{
  const fake=fakeDatabase();
  const first=await backfill(fake.sql,{now:()=>fake.now});
  assert.deepEqual(first,{backfilled:1});
  assert.equal(fake.current.length,1);
  assert.equal(fake.current[0].text,'Аня: Была на группе.');
  assert.equal(fake.current[0].admission_id,'admission_anna');
  assert.equal(fake.history.length,1);
  const second=await backfill(fake.sql,{now:()=>fake.now});
  assert.deepEqual(second,{backfilled:0});
  assert.deepEqual(fake.writes,['current','history']);
});

test('unsafe namesakes, expired sources and a historical admission collision are never backfilled',async()=>{
  for(const config of [{secondAnna:true},{expired:true},{otherAdmission:true}]){
    const fake=fakeDatabase(config);
    assert.deepEqual(await backfill(fake.sql,{now:()=>fake.now}),{backfilled:0});
    assert.equal(fake.current.length,0);
    assert.equal(fake.writes.length,0);
  }
});
