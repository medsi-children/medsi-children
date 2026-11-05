const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {Readable}=require('node:stream');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function psychology(fetch,stored={}){
  const elements=new Map();
  const document={getElementById(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,classList:{add(){},remove(){},toggle(){}},focus(){},addEventListener(){}});return elements.get(id)}};
  const context={document,window:{},localStorage:{getItem:key=>stored[key]||'',setItem:(key,value)=>{stored[key]=value}},AbortController,fetch,setTimeout,clearTimeout,Date,console};
  vm.createContext(context);
  vm.runInContext(read('psychology/app.js').replace('  restoreTutorSession();','  window.test={callApi,restoreTutorSession,sendReport};'),context);
  return {context,elements};
}
test('psychology restores the cached D1 session and sends through the queue',async()=>{
  const session={token:'synthetic',expiresAt:Date.now()+60000};
  const x=psychology(()=>{throw new Error('Slow route must not be used')},{medsi_tutor_session_v1:'synthetic-tutor',medsi_psychology_d1_session_v1:JSON.stringify(session)});
  const calls=[];
  x.context.MedsiOverlayTransport=x.context.window.MedsiOverlayTransport={reportSubmit:async(s,p)=>{calls.push({s,p});return {accepted:true}}};
  await x.context.window.test.restoreTutorSession();
  x.elements.get('text').value='Synthetic psychology report';
  await x.context.window.test.sendReport();
  assert.equal(calls.length,1);
  assert.equal(calls[0].s.token,session.token);
  assert.equal(calls[0].p.reportType,'psychology');
});
test('psychology normalizes an abort during body reading for idempotent recovery',async()=>{
  const x=psychology(async(_,options)=>({ok:true,text:()=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))}));
  await assert.rejects(x.context.window.test.callApi('appendReport',[],5),{message:'TIMEOUT'});
});
test('session guard refuses retired upstream requests and preserves native local fetch',async()=>{
  const calls=[];
  const window={
    location:{href:'https://medsi.example.invalid/tutors'},
    fetch:async(url,options)=>{calls.push({url,options});return {ok:true}}
  };
  vm.runInNewContext(read('chat-overlay/session-client.js'),{window,URL,JSON,Promise,Error});
  const controller=new AbortController();
  await assert.rejects(window.fetch('https://script.google.com/macros/s/synthetic/exec',{
    body:JSON.stringify({action:'api',method:'verifyTutorSession',args:[]}),
    signal:controller.signal
  }),/LEGACY_UPSTREAM_DISABLED/);
  await assert.rejects(window.fetch('https://medsi-chat-worker.medsi-children.workers.dev/lab/profile'),/LEGACY_UPSTREAM_DISABLED/);
  await assert.rejects(window.fetch('https://drive.google.com/thumbnail?id=fake'),/LEGACY_UPSTREAM_DISABLED/);
  assert.equal(calls.length,0);
  await window.fetch('/__session/api',{signal:controller.signal});
  assert.equal(calls[0].url,'/__session/api');
  assert.equal(calls[0].options.signal,controller.signal);
  controller.abort();
  assert.equal(calls[0].options.signal.aborted,true);
});

function worker(){const context={Response,console};vm.createContext(context);vm.runInContext(read('services/cloudflare/chat-worker/src/index.js').replace('export default {','const worker = {'),context);return context;}
test('malformed or truncated reconciliation cannot touch D1',async()=>{
  const x=worker();let reads=0;
  const env={CHAT_DB:{prepare(){reads++;throw new Error('Must validate before touching D1')}}};
  for(const payload of [{full:true},{full:true,profiles:'bad'},{full:true,profiles:[{}]},{full:true,profiles:Array.from({length:501},(_,i)=>({phone:String(9990000000+i)}))}]){
    const response=await x.reconcileProfiles({json:async()=>payload},env);
    assert.equal(response.status,400);
    assert.equal((await response.json()).code,'INVALID_PROFILE_SNAPSHOT');
  }
  assert.equal(reads,0);
});
test('valid reconciliation still writes profiles and retains explicit empty-snapshot semantics',async()=>{
  const x=worker();const writes=[];
  const env={CHAT_DB:{prepare(sql){return {bind(){return this},all:async()=>({results:[]}),sql}},batch:async statements=>{writes.push(...statements)}}};
  let response=await x.reconcileProfiles({json:async()=>({profiles:[{phone:'9990000001',parentName:'Synthetic',childName:'Synthetic'}]})},env);
  assert.equal((await response.json()).active,1);assert.equal(writes.length,2);
  response=await x.reconcileProfiles({json:async()=>({full:true,profiles:[]})},env);
  assert.equal((await response.json()).ok,true);
});
function previews(storage){
  let resized=0;
  const sharp=()=>{resized++;return {rotate(){return this},resize(){return this},webp(){return this},toBuffer:async()=>Buffer.from('preview')}};
  const context={require:name=>name==='sharp'?sharp:name==='./s3-storage'?storage:require(name),Buffer,Map,module:{exports:{}},console:{warn(){}}};
  vm.runInNewContext(read('lib/media-previews.js'),context);
  return {api:context.module.exports,resized:()=>resized};
}
test('concurrent requests resize and upload the same preview once',async()=>{
  let reads=0,puts=0;
  const x=previews({configured:true,hasObject:async()=>false,getObject:async()=>{reads++;return {ContentType:'image/png',Body:Readable.from([Buffer.from('image')])}},putBuffer:async()=>{puts++}});
  const results=await Promise.all(Array.from({length:8},()=>x.api.ensure('synthetic.png')));
  assert.equal(new Set(results).size,1);assert.ok(results[0]);assert.equal(reads,1);assert.equal(puts,1);assert.equal(x.resized(),1);
});
test('oversized streams without a length are bounded and remain retryable',async()=>{
  let reads=0;const streams=[];
  const x=previews({configured:true,hasObject:async()=>false,getObject:async()=>{reads++;const body=Readable.from([Buffer.alloc(14*1024*1024),Buffer.alloc(14*1024*1024)]);streams.push(body);return {ContentType:'image/png',Body:body}},putBuffer:async()=>assert.fail('Oversized source was uploaded')});
  assert.equal(await x.api.ensure('large'),null);
  assert.equal(await x.api.ensure('large'),null);
  assert.equal(reads,2);assert.equal(x.resized(),0);
  assert.equal(streams.every(body=>body.destroyed),true);
});
test('discarded non-images and known oversized objects release their S3 streams',async()=>{
  for(const meta of [{ContentType:'video/mp4'},{ContentType:'image/png',ContentLength:26*1024*1024}]){
    const body=Readable.from([Buffer.from('unused')]);
    const x=previews({configured:true,hasObject:async()=>false,getObject:async()=>({...meta,Body:body})});
    assert.equal(await x.api.ensure('unused'),null);assert.equal(body.destroyed,true);assert.equal(x.resized(),0);
  }
});
test('psychology page loads the queue transport before the report form',()=>{
  const html=read('psychology.html');
  const scripts=[...html.matchAll(/<script\b[^>]*src="([^"?]+)/g)].map(match=>match[1]);
  assert.ok(scripts.indexOf('/chat-overlay/transport.js')>=0);
  assert.ok(scripts.indexOf('/psychology/app.js')>scripts.indexOf('/chat-overlay/transport.js'));
});
test('registration, retry, namesake overlap and discharge preserve the remaining family',async()=>{
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(':memory:');
  const dir=path.join(__dirname,'..','services/cloudflare/chat-worker/migrations');
  fs.readdirSync(dir).filter(file=>file.endsWith('.sql')).sort().forEach(file=>db.exec(fs.readFileSync(path.join(dir,file),'utf8')));
  const adapter={prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this},async first(){return db.prepare(sql).get(...this.args)||null},async all(){return {results:db.prepare(sql).all(...this.args)}},async run(){return {meta:{changes:db.prepare(sql).run(...this.args).changes}}}}},async batch(statements){db.exec('BEGIN');try{const values=statements.map(s=>({meta:{changes:db.prepare(s.sql).run(...s.args).changes}}));db.exec('COMMIT');return values}catch(error){db.exec('ROLLBACK');throw error}}};
  const context={Response,console,TextEncoder,Uint8Array,btoa,crypto:require('node:crypto').webcrypto};
  vm.createContext(context);vm.runInContext(read('services/cloudflare/chat-worker/src/index.js').replace('export default {','const worker = {'),context);
  const env={CHAT_DB:adapter,LAB_D1_SESSION_SECRET:'synthetic-only'};
  const req=value=>({json:async()=>value});
  const old={phone:'9990000001',parentName:'Анна Синтетическая',childName:'Александра Синтетическая',attemptId:'reg_synthetic_old_123456'};
  const added={phone:'9990000002',parentName:'Мария Синтетическая',childName:'Александр Синтетический',attemptId:'reg_synthetic_new_123456'};
  try{
    for(const person of [old,added]){
      const result=await (await context.registerParent(req(person),env)).json();
      assert.equal(result.ok,true);assert.ok(result.parentSession);
    }
    await context.registerParent(req(added),env);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_profiles').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parent_registration_outbox').get().n,2);
    let response=await context.reconcileProfiles(req({profiles:[old,added],full:true}),env);
    assert.equal((await response.json()).removed,0);
    db.prepare("INSERT INTO chat_messages(message_key,phone10,side,text,created_at) VALUES(?,?,'parent',?,?)").run('old_message',old.phone,'Synthetic old message',1);
    db.prepare("INSERT INTO chat_messages(message_key,phone10,side,text,created_at) VALUES(?,?,'parent',?,?)").run('new_message',added.phone,'Synthetic new message',2);
    response=await context.reconcileProfiles(req({profiles:'broken',full:true}),env);
    assert.equal(response.status,400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n,2);
    response=await context.reconcileProfiles(req({profiles:[added],full:true}),env);
    assert.equal((await response.json()).removed,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_profiles').get().n,1);
    assert.equal(db.prepare('SELECT phone10 FROM chat_profiles').get().phone10,added.phone);
    assert.equal(db.prepare('SELECT message_key FROM chat_messages').get().message_key,'new_message');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parent_registration_outbox').get().n,1);
  }finally{db.close()}
});
