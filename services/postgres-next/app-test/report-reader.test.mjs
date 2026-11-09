import test from 'node:test';
import assert from 'node:assert/strict';
import {createReportReader} from '../app/report-reader.mjs';

function fakeSql({publishedTherapy=null,unlinked=false,failBackfill=false}={}){
  const data={
    profile:unlinked?{admission_id:'',parent_name:'Родитель',child_id:'',child_name:''}:{admission_id:'admission_NEW',parent_name:'Родитель',child_id:'c1'},
    child:{registered_first_name:'Лена',surname:'Тестовая'},
    current:[
      {kind:'morning',admission_id:'admission_NEW',version:'version_002',read_version:'',text:'Текущий отчёт',updated_at:3},
      {kind:'evening',admission_id:'admission_OLD',version:'version_001',read_version:'',text:'Прошлая госпитализация',updated_at:2}
    ],
    history:[
      {kind:'morning',report_date:'2026-11-03',admission_id:'admission_NEW',text:'Новый текст',captured_at:3},
      {kind:'evening',report_date:'2026-01-01',admission_id:'admission_OLD',text:'Старый текст',captured_at:1}
    ]
  };
  const reads=[];
  const sql={async begin(_opts,work){
    const tx=async(strings,...args)=>{
      const q=strings.join(' ').replace(/\s+/g,' ').trim();
      reads.push(q);
      if(failBackfill&&q.startsWith('SELECT phone10,child_id,admission_id FROM parent_profiles'))throw new Error('Synthetic recovery failed');
      if(q.includes('FROM parent_profiles'))return [[data.profile]];
      if(q.startsWith('SELECT child_id,status FROM admissions'))return [args[0]==='admission_NEW'?[{child_id:'c1',status:'active'}]:[]];
      if(q.startsWith('SELECT admission_id,child_id,status FROM admissions'))return [[]];
      if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [[]];
      if(q.startsWith('SELECT kind,publication_id FROM report_publication_head'))return [[]];
      if(q.startsWith('SELECT publication_id FROM report_publication_head'))return [publishedTherapy?[{publication_id:'psychology_latest'}]:[]];
      if(q.startsWith('SELECT normalized_text,submitted_at FROM raw_reports'))return [publishedTherapy?[{normalized_text:publishedTherapy,submitted_at:123456789}]:[]];
      if(q.startsWith('SELECT phone10 FROM parent_auth_profiles'))return [[]];
      if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [[]];
      if(q.includes('FROM children'))return [[data.child]];
      if(q.includes('FROM parent_current_reports')&&q.includes('AND kind='))return [[data.current.find(row=>row.kind===args[1])]];
      if(q.includes('FROM parent_current_reports'))return [data.current];
      if(q.includes('FROM parent_report_history'))return [data.history];
      if(q.startsWith('UPDATE parent_current_reports')){data.current[0].read_version=args[0];return [[]];}
      throw Error('Unexpected query '+q);
    };
    return work(tx);
  }};
  return {data,reads,sql};
}
test('parent sees only current admission reports and current admission history',async()=>{
  const {sql}=fakeSql();
  const r=createReportReader(sql);
  const now=await r.current('9000000001');
  assert.equal(now.reports.length,1);
  assert.equal(now.reports[0].text,'Текущий отчёт');
  const old=await r.history('9000000001');
  assert.equal(old.reports.length,1);
  assert.equal(old.reports[0].text,'Новый текст');
  const profile=await r.profile('9000000001');
  assert.equal(profile.childName,'Лена Тестовая');
});
test('parent unread flags clear only when matching active publication version',async()=>{
  const {sql,data}=fakeSql();
  const r=createReportReader(sql);
  assert.equal((await r.unread('9000000001')).reportUnread.morning,true);
  assert.equal((await r.unread('9000000001')).reportUnread.evening,false);
  assert.equal((await r.markRead('9000000001','morning','version_BAD')).skipped,true);
  assert.equal(data.current[0].read_version,'');
  assert.equal((await r.markRead('9000000001','morning','version_002')).skipped,false);
  assert.equal(data.current[0].read_version,'version_002');
  assert.equal((await r.markRead('9000000001','morning','version_002')).skipped,true);
});
test('invalid phone and kind fail before database access',async()=>{
  const {sql}=fakeSql();const r=createReportReader(sql);
  await assert.rejects(()=>r.current('90000'),/Invalid parent phone/);
  await assert.rejects(()=>r.markRead('9000000001','secret','v'),/Invalid report version/);
});

test('group therapy is always fetched from the latest published source, even for a late parent',async()=>{
  const value='Занятие: общая групповая терапия.\n\nИтоги: синтетический пример.';
  const {sql}=fakeSql({publishedTherapy:value});
  const result=await createReportReader(sql).current('9000000001');
  assert.equal(result.ok,true);
  const therapy=result.reports.find(r=>r.kind==='psychology');
  assert.equal(therapy.text,value);
  assert.equal(therapy.updatedAt,123456789);
  assert.match(therapy.version,/^[a-f0-9]{64}$/);
  assert.equal(result.reports.find(r=>r.kind==='morning').text,'Текущий отчёт');
  assert.equal(result.reports.some(r=>r.kind==='evening'),false);
});
test('unlinked authenticated parent still receives shared current therapy, without child report leakage',async()=>{
  const {sql}=fakeSql({publishedTherapy:'Общая терапия: тестовое занятие.',unlinked:true});
  const result=await createReportReader(sql).current('9000000001');
  assert.equal(result.ok,true);
  assert.equal(result.unlinked,true);
  assert.deepEqual(result.reports.map(r=>r.kind),['psychology']);
});

test('failed child backfill cannot hide current shared group therapy',async()=>{
  const {sql}=fakeSql({publishedTherapy:'Актуальная групповая терапия.',failBackfill:true});
  const result=await createReportReader(sql).current('9000000001');
  assert.equal(result.ok,true);
  assert.equal(result.reports.find(r=>r.kind==='psychology').text,'Актуальная групповая терапия.');
  assert.equal(result.reports.find(r=>r.kind==='morning').text,'Текущий отчёт');
});

test('empty admission identifiers never authorize old individual current/history records',async()=>{
  const {sql,data}=fakeSql({publishedTherapy:'Общий отчёт по терапии.',unlinked:true});
  data.current.push({kind:'morning',admission_id:'',version:'v_old',
    read_version:'',text:'Чужой прежний отчёт',updated_at:100});
  data.history.push({kind:'evening',admission_id:'',report_date:'2026-11-01',
    text:'Чужая история',captured_at:100});
  const reader=createReportReader(sql);
  const current=await reader.current('9000000001');
  assert.deepEqual(current.reports.map(r=>r.kind),['psychology']);
  assert.equal(current.reports[0].text,'Общий отчёт по терапии.');
  assert.deepEqual((await reader.history('9000000001')).reports,[]);
  assert.deepEqual((await reader.unread('9000000001')).reportUnread,{
    morning:false,evening:false,psychology:false
  });
  assert.equal((await reader.markRead('9000000001','morning','v_old')).skipped,true);
});
test('discharged or mismatched admission cannot reveal old personal reports',async()=>{
  for(const changed of [{admission_id:'admission_OLD',child_id:'c1'},
    {admission_id:'admission_NEW',child_id:'different_child'}]){
    const {sql,data}=fakeSql({publishedTherapy:'Общая терапия актуальна.'});
    Object.assign(data.profile,changed);
    const reader=createReportReader(sql);
    const current=await reader.current('9000000001');
    assert.deepEqual(current.reports.map(r=>r.kind),['psychology']);
    assert.deepEqual((await reader.history('9000000001')).reports,[]);
    assert.equal((await reader.unread('9000000001')).reportUnread.morning,false);
  }
});
