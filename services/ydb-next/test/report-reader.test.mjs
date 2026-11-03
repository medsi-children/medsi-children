import test from 'node:test';
import assert from 'node:assert/strict';
import {createReportReader} from '../src/report-reader.mjs';

function fakeSql(){
  const data={
    profile:{admission_id:'admission_NEW',parent_name:'Родитель',child_id:'c1'},
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
      if(q.includes('FROM parent_profiles'))return [[data.profile]];
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
