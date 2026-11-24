const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('service worker ignores empty and malformed payloads and keeps real notifications',async()=>{
  const listeners={},shown=[];
  const self={addEventListener:(name,handler)=>{listeners[name]=handler},
    registration:{showNotification:async(title,options)=>shown.push({title,options})}};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8'),{self});
  for(const payload of [null,{},'',{body:'  '}]){
    listeners.push({data:{json:()=>payload},waitUntil:()=>{}});
  }
  assert.equal(shown.length,0);
  listeners.push({data:{json:()=>({type:'chat',body:'Synthetic message'})},waitUntil:()=>{}});
  assert.equal(shown.length,1);
  assert.equal(shown[0].options.body,'Synthetic message');
});


test('push worker keeps the newest preview when the provider delivers older chat events later',async()=>{
  const listeners={},shown=[],visible=new Map();
  const self={addEventListener:(type,handler)=>{listeners[type]=handler},
    registration:{
      showNotification:async(title,options)=>{
        shown.push({title,options});
        visible.set(options.tag,{title,data:options.data});
      },
      getNotifications:async({tag})=>visible.has(tag)?[visible.get(tag)]:[]
    }
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8'),{self,Promise});
  const tag='medsi-chat-'+'f'.repeat(20);
  const push=async(messageAt,body)=>{
    let done;
    listeners.push({data:{json:()=>({type:'chat',body,title:'Тестовый чат',
      tag,url:'/tutors',messageAt})},waitUntil:promise=>{done=promise}});
    await done;
  };
  await push(2000,'Второе синтетическое сообщение');
  assert.equal(shown.length,1);
  await push(1000,'Первое синтетическое сообщение');
  assert.equal(shown.length,1,'Older delivered push must not overwrite newer preview');
  await push(3000,'Третье синтетическое сообщение');
  assert.equal(shown.length,2);
  assert.equal(shown[1].options.body,'Третье синтетическое сообщение');
  assert.equal(shown[1].options.renotify,true);
  assert.equal(shown[1].options.tag,tag);
  assert.equal(shown[1].options.data.messageAt,3000);
});

test('push ordering survives dismissal and service worker restarts with IndexedDB',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8');
  const durable=new Map(),shown=[],visible=new Map();
  const db={
    objectStoreNames:{contains:()=>true},
    createObjectStore(){},
    close(){},
    transaction(){
      const tx={oncomplete:null,onerror:null,onabort:null,
        objectStore:()=>({
          get(key){
            const request={};
            queueMicrotask(()=>{
              request.result=durable.get(key);
              request.onsuccess?.();
              queueMicrotask(()=>tx.oncomplete?.());
            });
            return request;
          },
          put(value,key){durable.set(key,value)}
        })
      };
      return tx;
    }
  };
  const indexedDB={open(){
    const request={};
    queueMicrotask(()=>{request.result=db;request.onsuccess?.()});
    return request;
  }};
  const tag='medsi-chat-'+'e'.repeat(20);
  async function receive(messageAt,body){
    const listeners={},self={
      indexedDB,addEventListener:(kind,listener)=>{listeners[kind]=listener},
      registration:{
        getNotifications:async({tag:key})=>visible.has(key)?[visible.get(key)]:[],
        showNotification:async(title,options)=>{
          shown.push({title,options});visible.set(options.tag,{data:options.data});
        }
      }
    };
    vm.runInNewContext(source,{self,Promise});
    let job;
    listeners.push({data:{json:()=>({type:'chat',tag,body,messageAt})},waitUntil:p=>{job=p}});
    await job;
  }
  await receive(2000,'Новое');
  assert.equal(durable.get(tag),2000);
  visible.clear(); // User dismissed the newest notification.
  await receive(1000,'Старое');
  assert.equal(shown.length,1,'Older event stays suppressed even after dismissal');
  await receive(3000,'Самое новое');
  assert.equal(durable.get(tag),3000);
  assert.equal(shown.length,2);
});

test('worker registration version is refreshed on both parent and educator screens',()=>{
  const root=require('node:path').join(__dirname,'..');
  const read=relative=>fs.readFileSync(require('node:path').join(root,relative),'utf8');
  assert.match(read('notify-client.js'),/sw\.js\?v=20261124-chat-order-1/);
  assert.match(read('index.html'),/notify-client\.js\?v=20261124-chat-order-1/);
  assert.match(read('tutors.html'),/notify-client\.js\?v=20261124-chat-order-1/);
});
