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
