const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..');
const psychology=fs.readFileSync(path.join(root,'psychology','app.js'),'utf8');
const educator=fs.readFileSync(path.join(root,'tutors','full-web.js'),'utf8');
const transportSource=fs.readFileSync(path.join(root,'chat-overlay','transport.js'),'utf8');

function harness(transport,adapter=async()=>{throw new Error('Unexpected legacy write')}) {
  const nodes=new Map(),store={
    medsi_tutor_session_v1:'test-tutor-session',
    medsi_psychology_d1_session_v1:JSON.stringify({token:'timeweb-pg-session',expiresAt:Date.now()+3600000})
  };
  const element=id=>{
    if(!nodes.has(id)){
      const classes=new Set(['hidden']);
      nodes.set(id,{id,value:'',textContent:'',disabled:false,handlers:{},focus(){},
        classList:{
          add:v=>classes.add(v),remove:v=>classes.delete(v),
          contains:v=>classes.has(v),
          toggle(v,on){if(on)classes.add(v);else classes.delete(v)}
        },
        addEventListener(type,listener){this.handlers[type]=listener}
      });
    }
    return nodes.get(id);
  };
  const window={crypto:{randomUUID:()=> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'},MedsiOverlayTransport:transport};
  const context={
    window,document:{getElementById:element},
    MedsiOverlayTransport:transport,
    localStorage:{getItem:key=>store[key]||'',setItem:(key,value)=>{store[key]=value}},
    fetch:adapter,
    setTimeout:()=>0,clearTimeout(){},
    console
  };
  vm.runInNewContext(psychology,context);
  return {
    element,store,
    async send(value) {element('text').value=value;await element('sendBtn').handlers.click()}
  };
}

test('psychologist and educator share the canonical Timeweb report route',()=>{
  assert.match(psychology,/MedsiOverlayTransport\.reportSubmit/);
  assert.match(educator,/MedsiOverlayTransport\.reportSubmit/);
  assert.match(transportSource,/request\(session, '\/lab\/report-submit'/);
  assert.match(psychology,/MedsiOverlayTransport\.reportStatus/);
  assert.doesNotMatch(psychology,/appendReport|getReportSubmissionStatus/);
  assert.doesNotMatch(psychology,/https?:\/\/|cloudflare\.com|script\.google\.com/i);
});

test('successful psychology report uses exactly one write and confirms server receipt',async()=>{
  const writes=[];
  const app=harness({reportSubmit:async(_session,payload,settings)=>{
    writes.push({payload,settings});
    return {ok:true,accepted:true,submissionId:payload.submissionId};
  }});
  await app.send('Вымышленный отчёт');
  assert.equal(writes.length,1);
  assert.equal(writes[0].payload.reportType,'psychology');
  assert.equal(writes[0].settings.retryTransientWrite,false);
  assert.equal(writes[0].settings.writeTimeoutMs,15000);
  assert.equal(app.element('doneScreen').classList.contains('hidden'),false);
});

test('HTTP 404 is visible and never triggers another write route',async()=>{
  let writes=0,checks=0;
  const app=harness({
    reportSubmit:async()=>{writes++;throw Object.assign(new Error('Not found'),{status:404,code:'HTTP-404'})},
    reportStatus:async()=>{checks++;return {status:'not_found'}}
  });
  await app.send('Вымышленный отчёт');
  assert.equal(writes,1);assert.equal(checks,0);
  assert.match(app.element('reportError').textContent,/404/);
  assert.equal(app.element('text').value,'Вымышленный отчёт');
});

test('lost response is recovered with a read-only receipt check',async()=>{
  let writes=0,reads=0;
  const app=harness({
    reportSubmit:async()=>{writes++;throw Object.assign(new Error('Connection dropped'),{code:'NETWORK'})},
    reportStatus:async(_session,id)=>{
      reads++;return {ok:true,submissionId:id,status:'completed'}
    }
  });
  await app.send('Вымышленный отчёт');
  assert.equal(writes,1);assert.equal(reads,1);
  assert.equal(app.element('doneScreen').classList.contains('hidden'),false);
});

test('unconfirmed write keeps its submission ID for safe manual retry',async()=>{
  const ids=[];let attempts=0;
  const app=harness({
    reportSubmit:async(_session,payload)=>{
      ids.push(payload.submissionId);attempts++;
      if(attempts===1)throw Object.assign(new Error('Connection dropped'),{code:'NETWORK'});
      return {ok:true,accepted:true,submissionId:payload.submissionId};
    },
    reportStatus:async()=>({ok:true,status:'not_found'})
  });
  await app.send('Вымышленный отчёт');
  assert.match(app.element('reportError').textContent,/не подтверждено/);
  assert.equal(app.element('doneScreen').classList.contains('hidden'),true);
  await app.send('Вымышленный отчёт');
  assert.deepEqual(ids,[ids[0],ids[0]]);
  assert.equal(app.element('doneScreen').classList.contains('hidden'),false);
});

test('empty report is blocked before network access',async()=>{
  const app=harness({reportSubmit:async()=>{throw new Error('must not send')}});
  await app.send(' ');
  assert.match(app.element('reportError').textContent,/Пустой текст/);
});
