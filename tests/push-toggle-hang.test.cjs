const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('a browser unsubscribe that never settles cannot leave the push control pending',async()=>{
  const storage=new Map([['medsi_push_wanted_v1:parent:9990000011','yes']]);
  const timers=new Map();let nextTimer=0,deleteCalls=0;
  const subscription={endpoint:'https://push.example/device',toJSON(){return {endpoint:this.endpoint,keys:{auth:'test',p256dh:'test'}}},unsubscribe(){return new Promise(()=>{});}};
  const node=()=>({classList:{toggle(){},add(){},remove(){}},textContent:'',appendChild(){},addEventListener(){}});
  const window={PushManager:function(){},Notification:{permission:'granted',requestPermission:async()=>'granted'},addEventListener(){},atob:value=>Buffer.from(value,'base64').toString('binary')};
  const context={window,Notification:window.Notification,navigator:{userAgent:'test',serviceWorker:{register:async()=>({pushManager:{getSubscription:async()=>subscription}})}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},document:{hidden:false,addEventListener(){},createElement:node},AbortController,queueMicrotask,setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});if(ms===1500)queueMicrotask(fn);return id},clearTimeout:id=>timers.delete(id),fetch:async()=>{deleteCalls++;return {ok:true,json:async()=>({ok:true})}}};
  vm.createContext(context);
  const source=fs.readFileSync('notify-client.js','utf8').replace(/\}\)\(\);\s*$/,`window.audit={state};})();`);
  vm.runInContext(source,context);
  const api=window.MedsiPush;window.audit.state.identity={role:'parent',phone:'9990000011',parentSession:'test'};window.audit.state.pushServiceUrl='/push';window.audit.state.button=node();window.audit.state.status=node();

  assert.equal(await api.toggle(),false);
  assert.equal(storage.get('medsi_push_wanted_v1:parent:9990000011'),'no');
  assert.equal(deleteCalls,1);
  assert.match(window.audit.state.status.textContent,/Браузер завершает удаление подписки/);
});
