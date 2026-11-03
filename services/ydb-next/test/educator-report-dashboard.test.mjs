import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleEducatorReports, createEducatorReportsDashboardStore, educatorReportDashboardHandler } from '../src/educator-report-dashboard.mjs';

const dataset = () => ({
  profiles: [
    {phone10:'9000000001',parent_name:'Анна',relationship:'Мама',child_id:'child_1',admission_id:'admission_1'},
    {phone10:'9000000002',parent_name:'Владимир',relationship:'Папа',child_id:'child_1',admission_id:'admission_1'},
    {phone10:'9000000003',parent_name:'Мария',relationship:'Мама',child_id:'child_2',admission_id:'admission_2'}
  ],
  children: [
    {child_id:'child_1',registered_first_name:'Екатерина',surname:'Тестовая'},
    {child_id:'child_2',registered_first_name:'Таисия',surname:'Учебная'}
  ],
  admissions: [
    {admission_id:'admission_1',status:'active'}, {admission_id:'admission_2',status:'closed'}
  ],
  current:[
    {phone10:'9000000001',kind:'morning',text:'Екатерина: учебный отчёт'},
    {phone10:'9000000002',kind:'morning',text:'Екатерина: учебный отчёт'},
    {phone10:'9000000003',kind:'morning',text:'Таисия: старый отчёт'}
  ],
  heads:[{kind:'morning',publication_id:'pub_1'}],
  rawByPublication:new Map([['pub_1',{kind:'morning',report_date:'2026-11-03',raw_text:'Катя Т: исходный текст',normalized_text:'Катя Т. — исходный текст'}]])
});
test('dashboard groups two parents under child and never exposes discharged admission',()=>{
  const result=assembleEducatorReports(dataset());
  assert.equal(result.ok,true);
  assert.equal(result.children.length,1);
  assert.equal(result.children[0].parents.length,2);
  assert.equal(result.children[0].parentViews.length,2);
  assert.equal(result.children[0].childName,'Екатерина');
  assert.equal(result.raw.morning.normalizedText,'Катя Т. — исходный текст');
  assert.equal(result.raw.psychology.normalizedText,'');
  assert.equal(JSON.stringify(result).includes('Таисия: старый отчёт'),false);
});
test('dashboard refuses corrupted cross-child admission association',()=>{
  const data=dataset();
  data.profiles[1].child_id='child_2';
  assert.throws(()=>assembleEducatorReports(data),/identity conflict/);
});
test('dashboard queries active reports as one snapshot using YDB result set conventions',async()=>{
  const data=dataset();
  const expected={
    'SELECT phone10, parent_name, relationship, child_id, admission_id FROM parent_profiles':data.profiles,
    'SELECT child_id, registered_first_name, surname FROM children':data.children,
    'SELECT admission_id, status FROM admissions':data.admissions,
    'SELECT phone10, kind, text FROM parent_current_reports':data.current,
    'SELECT kind, publication_id FROM report_publication_head':data.heads
  };
  const calls=[];
  const sql={async begin(opts,fn){
    assert.equal(opts.isolation,'snapshotReadOnly');
    const tx=async (strings,...params)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      calls.push(q);
      if(q.startsWith('SELECT publication_id, kind'))return [[data.rawByPublication.get(params[0])]];
      const found=Object.entries(expected).find(([prefix])=>q.startsWith(prefix));
      if(!found)throw Error('Unexpected query: '+q);
      return [found[1]];
    };
    return fn(tx);
  }};
  const result=await createEducatorReportsDashboardStore(sql).readForEducator();
  assert.equal(result.children.length,1);
  assert.equal(result.raw.morning.normalizedText,'Катя Т. — исходный текст');
  assert.equal(calls.length,6);
});
test('HTTP endpoint never leaks reports to unauthenticated parent or parent preview',async()=>{
  let reads=0;
  const handler=educatorReportDashboardHandler({
    verifyEducator:async req=>req.auth,
    dashboardStore:{readForEducator:async()=>{reads++;return {ok:true,children:[],raw:{}}}}
  });
  function res(){
    return {statusCode:200,headers:{},status(v){this.statusCode=v;return this;},
      setHeader(k,v){this.headers[k]=v;return this;},json(v){this.body=v;return this}};
  }
  for(const auth of [undefined,{role:'parent'},{role:'parent',preview:true}]) {
    const r=res(); await handler({method:'GET',auth},r);
    assert.equal(r.statusCode,403);
    assert.equal(reads,0);
  }
  const ok=res(); await handler({method:'GET',auth:{role:'educator'}},ok);
  assert.equal(ok.statusCode,200);assert.equal(ok.headers['cache-control'],'no-store');assert.equal(reads,1);
});
