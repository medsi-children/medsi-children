const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function worker(send){
  const entries=new Map();
  const context={Response,URL,TextEncoder,crypto:webcrypto,
    webpush:{setVapidDetails(){},sendNotification:send}};
  vm.createContext(context);
  vm.runInContext(read('services/cloudflare/push-worker/src/index.js')
    .replace("import webpush from 'web-push';",'').replace('export default {','globalThis.worker = {'),context);
  context.verifyParentSession=async()=>true;
  const env={VAPID_PUBLIC_KEY:'test',VAPID_PRIVATE_KEY:'test',VAPID_SUBJECT:'test',PUSH_SUBSCRIPTIONS:{get:async key=>entries.get(key)||null,put:async(k,v)=>entries.set(k,v),list:async({prefix})=>({keys:[...entries.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))})}};
  return {context,env,entries,worker:context.worker};
}
function sub(endpoint){return {role:'parent',phone10:'9990000011',enabled:true,subscription:{endpoint,keys:{auth:'synthetic',p256dh:'synthetic'}}};}
test('expired endpoints are inactive; real delivery failures retain specific safe causes',async()=>{
  const x=worker(async subscription=>{throw Object.assign(new Error('private provider response'),{statusCode:subscription.endpoint.endsWith('/old')?410:503,body:'private body'})});
  x.entries.set('sub:old',JSON.stringify(sub('https://push.example/old')));
  x.entries.set('sub:temporary',JSON.stringify(sub('https://push.example/temporary')));
  const result=await x.context.sendNotificationToSubscribers(x.env,'parent','9990000011',{title:'synthetic'});
  assert.equal(result.inactive,1);assert.equal(result.failed,1);
  const event=JSON.parse([...x.entries].find(([key])=>key.startsWith('event:'))[1]);
  assert.deepEqual(event.deliveryErrors,[{statusCode:410,reason:'subscription_expired',provider:'push.example'},{statusCode:503,reason:'provider_unavailable',provider:'push.example'}]);
  assert.equal(JSON.parse(x.entries.get('sub:old')).enabled,false);
  assert.equal(JSON.parse(x.entries.get('sub:temporary')).enabled,true);
  assert.equal(JSON.stringify(event).includes('private'),false);
});
test('an explicit off switch is recorded as a fact and never attempted during sends',async()=>{
  let sends=0;const x=worker(async()=>sends++);const endpoint='https://push.example/device';
  const key='sub:'+await x.context.subscriptionKey(endpoint);x.entries.set(key,JSON.stringify(sub(endpoint)));
  await x.context.handleUnsubscribe({json:async()=>({endpoint})},x.env);
  assert.equal(JSON.parse(x.entries.get(key)).disabledReason,'user_disabled');
  const result=await x.context.sendNotificationToSubscribers(x.env,'parent','9990000011',{});
  assert.equal(result.total,0);assert.equal(result.failed,0);assert.equal(sends,0);
});
test('migration freeze blocks push writes while leaving health reads and preflight available',async()=>{
  const x=worker(async()=>{}),env={...x.env,MEDSI_MIGRATION_FREEZE:'1'};
  const post=await x.worker.fetch(new Request('https://push.example/subscribe',{method:'POST'}),env);
  assert.equal(post.status,503);assert.equal((await post.json()).code,'MIGRATION_WRITE_FREEZE');
  const get=await x.worker.fetch(new Request('https://push.example/'),env);
  assert.equal(get.status,200);
  const options=await x.worker.fetch(new Request('https://push.example/subscribe',{method:'OPTIONS'}),env);
  assert.equal(options.status,200);assert.equal(x.entries.size,0);
});
test('a dead endpoint cannot be silently marked enabled again',async()=>{
  const x=worker(async()=>{});const endpoint='https://push.example/dead';
  const value=sub(endpoint),key='sub:'+await x.context.subscriptionKey(endpoint);
  x.entries.set(key,JSON.stringify({...value,enabled:false,disabledReason:'subscription_expired'}));
  const response=await x.context.handleSubscribe({json:async()=>({role:'parent',phone:'9990000011',subscription:value.subscription})},x.env);
  assert.equal(response.status,409);assert.equal((await response.json()).code,'PUSH_SUBSCRIPTION_EXPIRED');
  assert.equal(JSON.parse(x.entries.get(key)).enabled,false);
});
function client({wanted,missing=false,permission='granted',fetcher}={}){
  const storage=new Map(),calls=[],timers=new Map();let created=0,live;
  function make(endpoint){return {endpoint,toJSON(){return {endpoint,keys:{auth:'synthetic',p256dh:'synthetic'}}},async unsubscribe(){live=null;return true}};}
  live=missing?null:make('https://push.example/old');
  const registration={pushManager:{getSubscription:async()=>live,subscribe:async()=>{created++;return live=make('https://push.example/fresh')}}};
  const node=()=>({classList:{toggle(){},add(){},remove(){}},textContent:'',appendChild(){},addEventListener(){}});
  const window={PushManager:function(){},Notification:{permission,requestPermission:async()=>permission},addEventListener(){},atob:s=>Buffer.from(s,'base64').toString('binary')};
  const context={window,Notification:window.Notification,navigator:{serviceWorker:{register:async()=>registration}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},document:{hidden:false,addEventListener(){},createElement:node},AbortController,setTimeout(fn,ms){const id=timers.size+1;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),fetch:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});return fetcher?fetcher(url,body):{ok:true,json:async()=>({ok:true})}}};
  vm.createContext(context);
  vm.runInContext(read('notify-client.js').replace(/\}\)\(\);\s*$/,`window.audit={state,recoverSubscription,unsubscribe,syncSubscription};})();`),context);
  const api=window.audit;api.state.identity={role:'parent',phone:'9990000011',parentSession:'synthetic'};api.state.button=node();api.state.status=node();api.state.pushServiceUrl='/push';
  if(wanted!==undefined)storage.set('medsi_push_wanted_v1:parent:9990000011',wanted);
  return {api,push:window.MedsiPush,storage,calls,timers,get created(){return created},get live(){return live}};
}
test('opening restores a previously enabled but missing subscription once',async()=>{
  const x=client({wanted:'yes',missing:true});
  await Promise.all([x.api.recoverSubscription(),x.api.recoverSubscription()]);
  assert.equal(x.created,1);assert.equal(x.calls.length,1);assert.equal(x.calls[0].url,'/push/subscribe');
  await x.api.recoverSubscription();assert.equal(x.calls.length,1);
});
test('explicitly disabled or never enabled notifications are not restored',async()=>{
  for(const config of [{wanted:'no'},{missing:true},{wanted:'yes',permission:'denied',missing:true}]){
    const x=client(config);await x.api.recoverSubscription();assert.equal(x.created,0);assert.equal(x.calls.length,0);
  }
});
test('provider-expired subscription is replaced instead of reusing a dead endpoint',async()=>{
  const x=client({wanted:'yes',fetcher:async(_,body)=>body.subscription.endpoint.endsWith('/old')?{ok:false,status:409,json:async()=>({ok:false,code:'PUSH_SUBSCRIPTION_EXPIRED'})}:{ok:true,json:async()=>({ok:true})}});
  await x.api.recoverSubscription();assert.equal(x.created,1);assert.equal(x.calls.length,2);assert.match(x.calls[1].body.subscription.endpoint,/fresh$/);
});
test('temporary network failure retries without dropping permission or subscription',async()=>{
  let offline=true;const x=client({wanted:'yes',fetcher:async()=>{if(offline)throw new Error('offline');return {ok:true,json:async()=>({ok:true})}}});
  await x.api.recoverSubscription();assert.ok([...x.timers.values()].some(t=>t.ms===30000));
  assert.ok(x.live);offline=false;await x.api.recoverSubscription();assert.equal(x.calls.length,2);
});
test('an offline disable is remembered and sent later without re-enabling',async()=>{
  let offline=true;const x=client({wanted:'yes',fetcher:async()=>{if(offline)throw new Error('offline');return {ok:true,json:async()=>({ok:true})}}});
  await assert.rejects(()=>x.api.unsubscribe());
  assert.equal(x.storage.get('medsi_push_wanted_v1:parent:9990000011'),'no');
  assert.equal(x.live,null);offline=false;await x.api.recoverSubscription();
  assert.equal(x.created,0);assert.equal(x.calls.at(-1).url,'/push/unsubscribe');
  assert.equal(x.calls.at(-1).body.reason,'user_disabled');
  assert.equal(x.storage.has('medsi_push_wanted_v1:parent:9990000011:off-endpoint'),false);
});

test('revoked browser permission is recorded as disabled even when the browser removed its subscription',async()=>{
  const x=client({wanted:'yes',missing:true,permission:'denied'});
  x.storage.set('medsi_push_wanted_v1:parent:9990000011:endpoint','https://push.example/old');
  await x.api.recoverSubscription();
  assert.equal(x.created,0);assert.equal(x.calls.length,1);
  assert.equal(x.calls[0].url,'/push/unsubscribe');assert.equal(x.calls[0].body.reason,'permission_revoked');
  await x.api.recoverSubscription();assert.equal(x.calls.length,1);
});
test('background retries stop after two attempts instead of polling forever',async()=>{
  const x=client({wanted:'yes',fetcher:async()=>{throw new Error('offline')}});
  await x.api.recoverSubscription();
  for(let n=0;n<3;n++){
    for(const [key,timer] of [...x.timers]) if(timer.ms===30000){x.timers.delete(key);timer.fn();}
    await x.api.state.recoveryPromise;
  }
  assert.equal(x.calls.length,3);assert.equal([...x.timers.values()].filter(t=>t.ms===30000).length,0);
});

test('a parent can enable notifications again after switching them off',async()=>{
  const x=client({wanted:'yes'});
  assert.equal(await x.push.toggle(),false);
  assert.equal(x.storage.get('medsi_push_wanted_v1:parent:9990000011'),'no');
  assert.equal(await x.push.toggle(),true);
  assert.equal(x.storage.get('medsi_push_wanted_v1:parent:9990000011'),'yes');
  assert.equal(x.created,1);assert.equal(x.calls.at(-1).url,'/push/subscribe');
});
test('the server accepts an explicitly re-enabled subscription after a user disabled it',async()=>{
  const x=worker(async()=>{});const endpoint='https://push.example/returning';
  const value=sub(endpoint),key='sub:'+await x.context.subscriptionKey(endpoint);
  x.entries.set(key,JSON.stringify({...value,enabled:false,disabledReason:'user_disabled'}));
  const response=await x.context.handleSubscribe({json:async()=>({role:'parent',phone:'9990000011',subscription:value.subscription})},x.env);
  assert.equal(response.status,200);assert.equal(JSON.parse(x.entries.get(key)).enabled,true);
  assert.equal(JSON.parse(x.entries.get(key)).disabledReason,undefined);
});

test('simultaneous saves of an expired subscription renew it only once',async()=>{
  const x=client({wanted:'yes',fetcher:async(_,body)=>body.subscription.endpoint.endsWith('/old')?{ok:false,status:409,json:async()=>({ok:false,code:'PUSH_SUBSCRIPTION_EXPIRED'})}:{ok:true,json:async()=>({ok:true})}});
  await Promise.all([x.api.syncSubscription(x.live),x.api.syncSubscription(x.live)]);
  assert.equal(x.created,1);assert.equal(x.calls.length,2);
});
