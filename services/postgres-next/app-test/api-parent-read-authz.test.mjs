import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createNextLabRouter} from '../app/api-router.mjs';

// Synthetic HTTP contract: staff and preview sessions never acknowledge
// private parent notifications, even when they can open a read-only chat.
async function fixture() {
  const calls=[];
  const sessions={
    verifyWorker: async token=>({
      'parent-a':{role:'parent',phone10:'9000000001'},
      'parent-b':{role:'parent',phone10:'9000000002'},
      'educator':{role:'educator',phone10:''},
      'preview':{role:'parent',phone10:'9000000001',preview:true}
    })[token]||null
  };
  const services={
    sessions,
    chatStore:{send:async()=>{calls.push({op:'send'});return {status:'created',messageKey:'synthetic-message'}}},
    chatOperations:{markRead:async(role,phone)=>{calls.push({role,phone});return {ok:true}}},
    reportReader:{markRead:async()=>{calls.push({op:'report-read'});return {ok:true}}},
    reports:{},dashboard:{},nameVariants:{},passkeys:{},
    parentRegistration:{},parentAccess:{},parentDeletion:{},push:{}
  };
  const app=express();
  app.use('/lab',createNextLabRouter(services));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function markRead(token,phone='9000000001') {
    const response=await fetch(base+'/lab/read-parent/'+phone,{
      method:'POST',headers:token?{'X-Medsi-Chat-Session':token}:{},
    });
    return {status:response.status,body:await response.json()};
  }
  const close=()=>new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  return {calls,base,markRead,close};
}

test('only parent can acknowledge their own chat messages',async()=>{
  const f=await fixture();
  try{
    const res=await f.markRead('parent-a');
    assert.equal(res.status,200);
    assert.equal(res.body.ok,true);
    assert.deepEqual(f.calls,[{role:'parent',phone:'9000000001'}]);
  }finally{await f.close();}
});

test('staff, other parent, preview and anonymous users cannot mark parent messages read',async()=>{
  const f=await fixture();
  try {
    for(const token of ['educator','parent-b','preview','']) {
      const result=await f.markRead(token);
      assert.ok([401,403].includes(result.status),token+': '+result.status);
      assert.equal(result.body.ok,false);
    }
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});

test('preview and foreign parent cannot send messages or mark reports read',async()=>{
  const f=await fixture();
  async function attempt(token,path,body) {
    const response=await fetch(f.base+'/lab/'+path,{
      method:'POST',headers:{
        'content-type':'application/json','X-Medsi-Chat-Session':token
      },body:JSON.stringify(body)
    });
    return {status:response.status,body:await response.json()};
  }
  try {
    const msg={phone:'9000000001',side:'parent',type:'text',
      text:'synthetic-only',clientMessageId:'synthetic-0001'};
    for(const token of ['preview','parent-b']) {
      const result=await attempt(token,'messages',msg);
      assert.equal(result.status,403,token);
      assert.equal(result.body.ok,false);
    }
    const report=await attempt('preview','report-read',{kind:'morning',version:'synthetic-v1'});
    assert.equal(report.status,403);
    assert.equal(report.body.ok,false);
    assert.deepEqual(f.calls,[]);
  }finally{await f.close();}
});
