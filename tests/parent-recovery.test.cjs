const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function environment(fetch){
  const elements=new Map(),storage=new Map(),timers=new Map(),intervals=new Map();let timerId=0,intervalId=0;
  const noop=()=>{};
  const node=()=>({classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},style:{},dataset:{},addEventListener:noop,setAttribute:noop,scrollTo:noop,replaceChildren:noop,appendChild:noop,querySelector:()=>null,value:'',textContent:''});
  const ctx={console,AbortController,URL,fetch,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{getElementById:id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id)},createElement:node,addEventListener:noop,body:node(),hidden:false},window:{fetch,scrollTo:noop,addEventListener:noop},navigator:{},alert:message=>{throw new Error('Unexpected alert: '+message)},requestAnimationFrame:noop,setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),setInterval:(fn,ms)=>{const id=++intervalId;intervals.set(id,{fn,ms});return id},clearInterval:id=>intervals.delete(id)};
  vm.createContext(ctx);return {ctx,elements,storage,timers,intervals};
}
function parent(fetch){
  const env=environment(fetch);
  let source=fs.readFileSync(path.join(root,'parents/full-web.js'),'utf8');
  source=source.replace('  boot();',`  window.audit={warmD1,warmReport,readD1,clearSession,openChat,runRegistrationFlow,setup(session){currentPhone='0000000000';parentSession='test-auth';d1Session=session;},setSession(session){d1Session=session;},cache:reportCache};`);
  vm.runInContext(source,env.ctx);return {...env,api:env.ctx.window.audit};
}
const session={token:'synthetic',expiresAt:Date.now()+3600000};
const response=value=>({ok:true,status:200,json:async()=>value,text:async()=>JSON.stringify(value)});
test('registration stops with a retry message when Cloudflare says the previous deletion is still running',async()=>{
  let calls=0;
  const env=parent(async()=>{calls++;return {ok:false,status:409,json:async()=>({ok:false,code:'DELETION_PENDING',message:'pending'})}});
  await env.api.runRegistrationFlow({phone:'89990000000',parentName:'Родитель Тест',childName:'Ребёнок Тест',attemptId:'reg_synthetic'});
  assert.equal(calls,1,'a known deletion block should not start endless status polling');
  assert.match(env.elements.get('registrationPendingText').textContent,/Предыдущее удаление профиля/);
  assert.equal(typeof env.elements.get('registrationRetryBtn').onclick,'function');
  assert.equal(typeof env.elements.get('registrationCancelBtn').onclick,'function');
});
test('parallel session renewal makes only one gateway request and allows its retries to finish',async()=>{
  let calls=0,resolve;const env=parent(()=>{calls++;return new Promise(r=>resolve=r)});env.api.setup({...session,expiresAt:0});
  const a=env.api.warmD1(),b=env.api.warmD1();assert.equal(calls,1);assert.ok([...env.timers.values()].some(t=>t.ms===35000));
  resolve(response({ok:true,result:session}));assert.equal((await a).token,'synthetic');assert.equal((await b).token,'synthetic');
});
test('hung report requests are aborted, released, and can be requested again',async()=>{
  let calls=0,healthy=false;const env=parent((url,options)=>{calls++;if(healthy)return Promise.resolve(response({ok:true,reports:[]}));return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))));});env.api.setup(session);
  const pending=env.api.warmReport('morning');await tick();
  assert.equal(calls,1);
  for(const timer of [...env.timers.values()])if(timer.ms===12000)timer.fn();await tick();
  for(const timer of [...env.timers.values()])if(timer.ms===400)timer.fn();await tick();
  for(const timer of [...env.timers.values()])if(timer.ms===12000)timer.fn();await tick();
  assert.equal(await pending,null);healthy=true;
  assert.ok((await env.api.warmReport('morning')).ok);assert.equal(calls,3);
});
test('expired report cache refreshes without restarting the page',async()=>{
  let calls=0;const env=parent(async()=>{calls++;return response({ok:true,reports:[{kind:'morning',text:'new',version:'2'}]})});env.api.setup(session);
  env.api.cache.morning={ok:true,text:'old',fetchedAt:Date.now()-61000};
  assert.equal((await env.api.warmReport('morning')).text,'new');assert.equal(calls,1);
  await env.api.warmReport('morning');assert.equal(calls,1);
});
test('late session renewal cannot restore a logged-out account',async()=>{
  let resolve;const env=parent(()=>new Promise(r=>resolve=r));env.api.setup(null);
  const pending=env.api.warmD1();env.api.clearSession();resolve(response({ok:true,result:session}));
  assert.equal(await pending,null);assert.equal(env.storage.has('medsi_d1_parent_session_v1'),false);
});
test('chat schedules recovery after first network failure',async()=>{
  const env=environment();env.ctx.window.MedsiOverlayTransport={thread:async()=>{throw Object.assign(new Error('offline'),{code:'NETWORK'})}};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/chat-screen.js'),'utf8'),env.ctx);
  await env.ctx.window.MedsiParentChatScreen.open({phone:'0000000000',session});
  assert.ok([...env.timers.values()].some(t=>t.ms===1500));
  assert.equal(env.elements.get('parentChatError').textContent,'Восстанавливаем соединение…');
});
test('chat obtains a fresh session before reading and does not wait for prewarm',async()=>{
  const env=environment();let used;
  env.ctx.window.MedsiParentPrewarm={peek:()=>null,ready:()=>new Promise(()=>{})};env.ctx.MedsiParentPrewarm=env.ctx.window.MedsiParentPrewarm;
  env.ctx.window.MedsiOverlayTransport={thread:async s=>{used=s.token;throw new Error('offline')}};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/chat-screen.js'),'utf8'),env.ctx);
  await env.ctx.window.MedsiParentChatScreen.open({phone:'0000000000',session:{token:'expired'},getSession:async()=>session});
  assert.equal(used,'synthetic');
});
test('rejected read token is renewed once and the read resumes',async()=>{
  let reads=0,renewals=0;const tokens=[];
  const env=parent(async(url,options)=>{
    if(url==='/__session/api'){renewals++;return response({ok:true,result:{...session,token:'renewed'}});}
    reads++;tokens.push(options.headers['X-Medsi-Chat-Session']);
    if(reads===1)return {ok:false,status:401,json:async()=>({ok:false})};
    return response({ok:true,reports:[]});
  });env.api.setup(session);
  const result=env.api.readD1('/lab/report-current');await tick();
  for(const timer of [...env.timers.values()])if(timer.ms===400)timer.fn();
  assert.ok((await result).ok);assert.equal(renewals,1);assert.deepEqual(tokens,['synthetic','renewed']);
});
test('parent boot loads the chat dependencies in order after the menu is ready',async()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const loaded=[];
  const window={MedsiParentApp:{ready:true,helpersReady(){}}};
  const document={getElementById:()=>({classList:{add(){},remove(){}}}),createElement:()=>({remove(){}}),head:{appendChild(script){loaded.push(script.src.split('?')[0]);queueMicrotask(()=>script.onload?.());}}};
  const context={window,document,setTimeout:()=>1,clearTimeout(){},Promise};
  const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(match=>!/^<script[^>]*\bsrc=/.test(match[0])).map(match=>match[1]);
  inline.forEach(code=>vm.runInNewContext(code,context));
  for(let i=0;i<8;i++)await tick();
  const core=['/parents/full-web.js','/chat-overlay/transport.js','/parents/prewarm.js','/parents/chat-screen.js'].map(file=>loaded.indexOf(file));
  assert.ok(core.every(index=>index>=0)&&core.every((index,i)=>i===0||index>core[i-1]));
});
test('empty chat renders after the first request failed and a background read recovered',async()=>{
  const env=environment();let offline=true;
  env.ctx.window.MedsiOverlayTransport={thread:async()=>{if(offline)throw new Error('offline');return {ok:true,messages:[]}},markRead:async()=>({ok:true})};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/chat-screen.js'),'utf8'),env.ctx);
  await env.ctx.window.MedsiParentChatScreen.open({phone:'0000000000',session});
  let rendered;env.elements.get('parentChatMessages').replaceChildren=el=>{rendered=el.textContent;};
  offline=false;await env.ctx.window.MedsiParentChatScreen.refresh({fresh:true,background:true});
  assert.equal(rendered,'Сообщений пока нет.');
});
test('a confirmed empty cache is shown immediately while the next read is still pending',async()=>{
  const env=environment();let finish;
  env.ctx.window.MedsiParentPrewarm={peek:()=>({ok:true,messages:[]})};env.ctx.MedsiParentPrewarm=env.ctx.window.MedsiParentPrewarm;
  env.ctx.window.MedsiOverlayTransport={thread:()=>new Promise(resolve=>finish=resolve),markRead:async()=>({ok:true})};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/chat-screen.js'),'utf8'),env.ctx);
  let rendered;env.ctx.document.getElementById('parentChatMessages').replaceChildren=el=>{if(el)rendered=el.textContent;};
  const opening=env.ctx.window.MedsiParentChatScreen.open({phone:'0000000000',session});await tick();
  assert.equal(rendered,'Сообщений пока нет.');finish({ok:true,messages:[]});await opening;
});
test('reopening is not locked by a previous unfinished chat read',async()=>{
  const env=parent(async()=>response({ok:true,result:{ok:true}}));env.api.setup(session);
  let opens=0;const completions=[];
  env.ctx.window.MedsiParentChatScreen={close(){},open(){opens++;return new Promise(resolve=>completions.push(resolve));}};
  env.ctx.MedsiParentChatScreen=env.ctx.window.MedsiParentChatScreen;
  const first=env.api.openChat();await tick();const second=env.api.openChat();await tick();
  assert.equal(opens,2);completions.forEach(resolve=>resolve());await Promise.all([first,second]);
});
test('previously loaded history remains available for display after its freshness interval',()=>{
  const env=environment();const saved={res:{ok:true,messages:[{messageKey:'example',text:'synthetic'}]},at:Date.now()-120000};
  env.ctx.sessionStorage={getItem:()=>JSON.stringify(saved),setItem:()=>{},removeItem:()=>{}};
  const noop=async()=>({ok:true});env.ctx.window.fetch=noop;
  env.ctx.window.MedsiOverlayTransport={thread:noop,sendMessage:noop,edit:noop,remove:noop,react:noop,markRead:noop,markUnread:noop,pin:noop,upload:noop};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/prewarm.js'),'utf8'),env.ctx);
  assert.equal(env.ctx.window.MedsiParentPrewarm.peek('0000000000').messages[0].messageKey,'example');
});
test('a valid parent treats a temporary D1 410 as retryable synchronization, never as an empty chat',async()=>{
  const env=environment(async()=>response({ok:true,result:{ok:true,parentSession:'auth'}}));
  env.ctx.sessionStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  env.storage.set('medsi_parent_auth_session_v1','auth');
  const closed=async()=>{throw Object.assign(new Error('profile missing'),{status:410,code:'CHAT_CLOSED'})};
  const noop=async()=>({ok:true});
  env.ctx.window.MedsiOverlayTransport={thread:closed,sendMessage:noop,edit:noop,remove:noop,react:noop,markRead:noop,markUnread:noop,pin:noop,upload:noop};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/prewarm.js'),'utf8'),env.ctx);
  await assert.rejects(()=>env.ctx.window.MedsiOverlayTransport.thread(session,'0000000000','',100,{fresh:true}),error=>error.code==='PROFILE_SYNC_PENDING'&&Number(error.status)===503);
});
test('a bootstrap-confirmed missing parent keeps the D1 410 closed-chat signal',async()=>{
  const env=environment(async()=>response({ok:true,result:{ok:false,code:'NOT_FOUND'}}));
  env.ctx.sessionStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  env.storage.set('medsi_parent_auth_session_v1','auth');
  const closed=async()=>{throw Object.assign(new Error('profile missing'),{status:410,code:'CHAT_CLOSED'})};
  const noop=async()=>({ok:true});
  env.ctx.window.MedsiOverlayTransport={thread:closed,sendMessage:noop,edit:noop,remove:noop,react:noop,markRead:noop,markUnread:noop,pin:noop,upload:noop};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/prewarm.js'),'utf8'),env.ctx);
  await assert.rejects(()=>env.ctx.window.MedsiOverlayTransport.thread(session,'0000000000','',100,{fresh:true}),error=>Number(error.status)===410);
});
test('saved D1 session starts a parent thread prewarm in the background',async()=>{
  let calls=0;const env=environment(async()=>response({ok:true,result:{ok:true,parentSession:'auth'}}));
  env.ctx.sessionStorage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
  env.storage.set('medsi_parent_phone','0000000000');
  env.storage.set('medsi_d1_parent_session_v1',JSON.stringify({phone:'0000000000',session}));
  const thread=async()=>{calls++;return {ok:true,messages:[]}},noop=async()=>({ok:true});
  env.ctx.window.MedsiOverlayTransport={thread,sendMessage:noop,edit:noop,remove:noop,react:noop,markRead:noop,markUnread:noop,pin:noop,upload:noop};
  vm.runInContext(fs.readFileSync(path.join(root,'parents/prewarm.js'),'utf8'),env.ctx);await tick();
  assert.equal(calls,1);
});
test('parent prewarm refuses old Google URLs and preserves local cancellation',async()=>{
  const calls=[];
  const env=environment(async(url,options)=>{
    calls.push({url,options});
    return response({ok:true});
  });
  vm.runInContext(fs.readFileSync(path.join(root,'parents/prewarm.js'),'utf8'),env.ctx);
  const controller=new AbortController();
  await assert.rejects(env.ctx.window.fetch('https://script.google.com/macros/s/synthetic/exec',{
    body:JSON.stringify({action:'api',method:'getD1ChatSession',args:[]}),
    signal:controller.signal
  }),/LEGACY_UPSTREAM_DISABLED/);
  await assert.rejects(env.ctx.window.fetch('https://example.foo.workers.dev/lab/profile'),/LEGACY_UPSTREAM_DISABLED/);
  assert.equal(calls.length,0);
  await env.ctx.window.fetch('/__session/api',{signal:controller.signal});
  assert.equal(calls[0].url,'/__session/api');
  assert.equal(calls[0].options.signal,controller.signal);
});

test('educator preview opens the actual parent menu immediately and never renews through a saved parent account',async()=>{
  const requests=[];
  // Data may still be loading: showing the menu must not depend on the network.
  const env=environment((url,options)=>{requests.push({url,options});return new Promise(()=>{})});
  env.storage.set('medsi_parent_phone','9990000011');
  env.storage.set('medsi_parent_auth_session_v1','existing-parent-session');
  const before=[...env.storage];
  const preview={phone:'9991112233',parentSession:'preview-session',parentName:'Тестовый родитель',childName:'Тестовый ребёнок',expiresAt:Date.now()+900000};
  env.ctx.sessionStorage={getItem:key=>key==='medsi_parent_preview_once'?JSON.stringify(preview):null};
  env.ctx.document.body.insertBefore=()=>{};
  env.ctx.URL=URL;
  env.ctx.location={href:'https://example.test/'};
  const create=env.ctx.document.createElement;
  env.ctx.document.createElement=()=>({...create(),querySelector:()=>({})});
  const source=fs.readFileSync(path.join(root,'parents/full-web.js'),'utf8').replace('  boot();','  window.audit={warmD1,setSession(value){d1Session=value}};boot();');
  vm.runInContext(source,env.ctx);
  assert.equal(env.ctx.document.body.dataset.screen,'screenChoose');
  assert.equal(env.elements.get('childChip').textContent,preview.childName);
  assert.equal(env.ctx.window.MedsiParentApp.ready,true);
  assert.deepEqual([...env.storage],before);
  assert.equal((await env.ctx.window.audit.warmD1(true)).token,preview.parentSession);
  env.ctx.window.audit.setSession({token:preview.parentSession,expiresAt:0});
  await assert.rejects(()=>env.ctx.window.audit.warmD1(true),/Время предварительного просмотра истекло/);
  assert.equal(requests.some(r=>r.url==='/__session/apps-script'),false);
  assert.equal(requests.some(r=>r.options&&r.options.method==='POST'),false);
});

test('preview never installs the saved parent fetch wrapper or prewarms another account',()=>{
  let calls=0;const env=environment(async()=>{calls++;return response({ok:true})});
  env.storage.set('medsi_parent_phone','9990000011');
  env.storage.set('medsi_parent_auth_session_v1','existing-session');
  env.storage.set('medsi_d1_parent_session_v1',JSON.stringify({phone:'9990000011',session}));
  env.ctx.document.body.classList.contains=name=>name==='parent-preview-mode';
  const fetch=env.ctx.window.fetch,before=[...env.storage];
  vm.runInContext(fs.readFileSync(path.join(root,'parents/prewarm.js'),'utf8'),env.ctx);
  assert.equal(env.ctx.window.fetch,fetch);
  assert.equal(env.ctx.window.__medsiTimewebSessionFetchWrapped,undefined);
  assert.equal(env.intervals.size,0);
  assert.equal(calls,0);
  assert.deepEqual([...env.storage],before);
});

test('opening a report bypasses a fresh cached result while preserving it if the network fails',async()=>{
  let calls=0,healthy=true;
  const env=parent(async()=>{calls++;if(!healthy)throw Object.assign(new Error('Unavailable'),{status:403});return response({ok:true,reports:[{kind:'morning',text:'Current report',version:'current',updatedAt:100}]})});
  env.api.setup(session);
  for(const kind of ['morning','evening','psychology'])env.api.cache[kind]={ok:true,text:'Cached report',hasReport:true,fetchedAt:Date.now()};
  assert.equal((await env.api.warmReport('morning')).text,'Cached report');
  assert.equal(calls,0);
  assert.equal((await env.api.warmReport('morning',true)).text,'Current report');
  assert.equal(calls,1);
  healthy=false;
  assert.equal(await env.api.warmReport('morning',true),null);
  assert.equal(env.api.cache.morning.text,'Current report');
});

test('unknown login phone exits spinner, shows registration guidance and never polls forever',async()=>{
  let calls=0;
  const env=parent(async(url)=>{
    calls++;
    assert.match(url,/parent-auth\/request/);
    return response({ok:false,code:'NOT_FOUND',message:'not registered'});
  });
  env.elements.get('phoneInputAuth').value='89990000000';
  await env.elements.get('authBtn').onclick();
  await tick();await tick();
  assert.equal(calls,1,'unknown phone must not trigger repeated auth requests');
  assert.match(env.elements.get('phoneErrorAuth').textContent,/Номер телефона не найден/);
  assert.match(env.elements.get('phoneErrorAuth').textContent,/«Регистрация»/);
  assert.equal(env.ctx.document.body.dataset.screen,'screenAuth');
  assert.equal(env.storage.has('medsi_parent_reauthorization_v1'),false);
  assert.equal(typeof env.elements.get('authUnknownRegisterBtn').onclick,'function');
  env.elements.get('authUnknownRegisterBtn').onclick();
  assert.equal(env.ctx.document.body.dataset.screen,'screenNames');
});
test('temporary login network error is not incorrectly presented as an unregistered phone',async()=>{
  const env=parent(async()=>{throw new Error('Network unavailable')});
  env.elements.get('phoneInputAuth').value='89990000000';
  await env.elements.get('authBtn').onclick();await tick();await tick();
  assert.doesNotMatch(env.elements.get('phoneErrorAuth').textContent,/Номер телефона не найден/);
});
