const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','parents','full-web.js'),'utf8');
function section(start,end){
  const i=source.indexOf(start),j=source.indexOf(end,i+start.length);
  assert.ok(i>=0&&j>i,'Missing application functions '+start);
  return source.slice(i,j);
}
const helpers=section('  function warmAllReports(forceKind){','  function refreshParentMenu(){');
const open=section('  async function openReport(kind,refreshOnly){','  function showSchedule(){');

function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no});
  return {promise,resolve,reject};
}
function report(text){
  return {morning:{ok:true,text:'',hasReport:false},evening:{ok:true,text:'',hasReport:false},
    psychology:{ok:true,text,version:text,hasReport:true,updatedAt:Date.now()}};
}
function prefetchHarness(){
  const requests=[];
  const env={
    currentPhone:'9000000001',parentSession:'parent-session',reportCache:{},
    reportPending:{},reportFetchGeneration:0,
    freshReport(){return false},
    fetchCurrentReportsFromD1(){
      const job=deferred();requests.push(job);return job.promise;
    },Date
  };
  vm.createContext(env);
  vm.runInContext(helpers+';globalThis.warmReport=warmReport;globalThis.prewarmAll=prewarmAll;',env);
  return {env,requests};
}
function screenHarness({cached,pending,load}={}){
  const render=[],calls=[],nodes=new Map();
  const node=id=>{
    if(!nodes.has(id)){
      const hidden=new Set();
      nodes.set(id,{innerHTML:'',textContent:'',classList:{
        add:x=>hidden.add(x),remove:x=>hidden.delete(x),
        contains:x=>hidden.has(x),toggle:(x,flag)=>flag?hidden.add(x):hidden.delete(x)
      }});
    }
    return nodes.get(id);
  };
  const ctx={
    reportRun:0,currentReportKind:'',currentReportText:'',
    reportPending:pending?{psychology:pending}:{},
    reportCache:{psychology:cached||{ok:true,text:'Старый отчёт',hasReport:true}},
    window:{},document:{hidden:false,body:{dataset:{screen:'screenChoose'}}},
    $:node,reportTitle:()=> 'Психотерапия',setHeader(){},
    show(id){this.document.body.dataset.screen=id},
    hideReportBadge(){},showReportResult(kind,result){render.push(result.text)},
    warmReport(kind,force){calls.push({kind,force});return load?load():Promise.resolve(null)},
    setTimeout(){return 0}
  };
  // show() is called as a free function, and must not depend on its receiver.
  ctx.show=id=>{ctx.document.body.dataset.screen=id};
  vm.createContext(ctx);
  vm.runInContext(open+';globalThis.openReport=openReport;',ctx);
  return {ctx,node,render,calls};
}

test('opening the parent menu always starts fresh prefetch for all reports',()=>{
  assert.match(source,/function showChoose\(\)\{[\s\S]*?prewarmAll\(true\);show\('screenChoose'\)/);
  const {env,requests}=prefetchHarness();
  env.prewarmAll(true);
  assert.equal(requests.length,1);
  assert.ok(env.reportPending.psychology);
});

test('parent therapy waits for menu prefetch and never displays old cache',async()=>{
  const pending=deferred();
  const {ctx,render,calls}=screenHarness({pending:pending.promise});
  const opening=ctx.openReport('psychology');
  assert.deepEqual(render,[]);
  assert.equal(calls.length,0);
  pending.resolve({ok:true,text:'Новый отчёт',hasReport:true});
  await opening;
  assert.deepEqual(render,['Новый отчёт']);
});

test('after prefetch completes, opening therapy checks Timeweb again',async()=>{
  const fresh=deferred();
  const {ctx,render,calls}=screenHarness({load:()=>fresh.promise});
  const opening=ctx.openReport('psychology');
  assert.deepEqual(render,[]);
  assert.deepEqual(calls,[{kind:'psychology',force:true}]);
  fresh.resolve({ok:true,text:'Свежий отчёт',hasReport:true});
  await opening;
  assert.deepEqual(render,['Свежий отчёт']);
});

test('on a failed fetch no stale clinical text or technical warning is shown',async()=>{
  const {ctx,render,node}=screenHarness({load:()=>Promise.resolve(null)});
  await ctx.openReport('psychology');
  assert.deepEqual(render,[]);
  assert.match(node('reportContent').innerHTML,/Загружаем отчёт/);
  assert.equal(node('reportError').textContent,'');
  assert.equal(node('reportError').classList.contains('hidden'),true);
});

test('slower menu prefetch never overwrites a newer confirmed report',async()=>{
  const {env,requests}=prefetchHarness();
  const old=env.warmReport('psychology',false);
  const fresh=env.warmReport('psychology',true);
  assert.equal(requests.length,2);
  requests[1].resolve(report('Новый отчёт'));
  assert.equal((await fresh).text,'Новый отчёт');
  requests[0].resolve(report('Старый отчёт'));
  assert.equal(await old,null);
  assert.equal(env.reportCache.psychology.text,'Новый отчёт');
});
