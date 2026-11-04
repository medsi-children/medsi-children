'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {createTestApi,runSyntheticE2E}=require('../services/s3-hybrid/test-api.cjs');

const TOKENS={
  educator:'a'.repeat(64),parentA:'b'.repeat(64),parentB:'c'.repeat(64)
};
function memoryObjects(){
  const data=new Map();
  return {
    data,
    async getJson(key){return data.has(key)?structuredClone(data.get(key)):null;},
    async putOnce(key,value){
      if(data.has(key)){
        if(JSON.stringify(data.get(key))===JSON.stringify(value))return {created:false};
        throw new Error('S3_HYBRID_IMMUTABLE_CONFLICT');
      }
      data.set(key,structuredClone(value));return {created:true};
    },
    async listJsonKeys(prefix,{limit=1000}={}){
      const keys=[...data.keys()].filter(key=>key.startsWith(prefix)).sort();
      if(keys.length>limit)throw new Error('S3_HYBRID_SCAN_LIMIT');
      return keys;
    },
    async remove(key){data.delete(key);}
  };
}
async function listen(handler){
  const server=http.createServer((request,response)=>{
    Promise.resolve(handler(request,response)).catch(()=>{
      if(!response.headersSent){response.writeHead(503);response.end();}
    });
  });
  server.listen(0,'127.0.0.1');
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  return {server,base:'http://127.0.0.1:'+server.address().port};
}
function auth(token){return {authorization:'Bearer '+token,'content-type':'application/json'};}

test('synthetic two-family API isolates parent data and allows educator report publishing',async()=>{
  const objects=memoryObjects();
  const env={MEDSI_S3_HYBRID_STAND:'1',MEDSI_S3_E2E_API_ENABLED:'1',
    S3_STAND_EDUCATOR_TOKEN:TOKENS.educator,
    S3_STAND_PARENT_A_TOKEN:TOKENS.parentA,
    S3_STAND_PARENT_B_TOKEN:TOKENS.parentB};
  const api=createTestApi({objects,env,now:()=>Date.parse('2026-11-04T12:00:00Z')});
  const {server,base}=await listen(api.handle);
  const messageId='message_'+('a'.repeat(32));
  const publicationId='publication_'+('b'.repeat(32));
  try{
    let response=await fetch(base+'/api/test/chat?familyId=family-a');
    assert.equal(response.status,401);
    response=await fetch(base+'/api/test/chat',{method:'POST',headers:auth(TOKENS.parentA),
      body:JSON.stringify({familyId:'family-a',messageId,text:'Синтетическое сообщение семьи А'})});
    assert.equal(response.status,201);
    response=await fetch(base+'/api/test/chat?familyId=family-a',{headers:auth(TOKENS.parentA)});
    assert.equal(response.status,200);
    assert.equal((await response.json()).messages[0].text,'Синтетическое сообщение семьи А');
    response=await fetch(base+'/api/test/chat?familyId=family-b',{headers:auth(TOKENS.parentA)});
    assert.equal(response.status,403);
    response=await fetch(base+'/api/test/reports',{method:'POST',headers:auth(TOKENS.parentA),
      body:JSON.stringify({kind:'morning',date:'2026-11-04',revision:1,
        publicationId,reports:[{familyId:'family-a',text:'Тестовый отчёт А'}]})});
    assert.equal(response.status,403);
    response=await fetch(base+'/api/test/reports',{method:'POST',headers:auth(TOKENS.educator),
      body:JSON.stringify({kind:'morning',date:'2026-11-04',revision:1,
        publicationId,reports:[
          {familyId:'family-a',text:'Тестовый отчёт А'},
          {familyId:'family-b',text:'Тестовый отчёт Б'}
        ]})});
    assert.equal(response.status,201);
    response=await fetch(base+'/api/test/reports?familyId=family-a',{headers:auth(TOKENS.parentA)});
    assert.equal((await response.json()).reports[0].text,'Тестовый отчёт А');
    response=await fetch(base+'/api/test/reports?familyId=family-b',{headers:auth(TOKENS.parentA)});
    assert.equal(response.status,403);
    response=await fetch(base+'/api/test/reports?familyId=family-b',{headers:auth(TOKENS.parentB)});
    assert.equal((await response.json()).reports[0].text,'Тестовый отчёт Б');
    response=await fetch(base+'/api/test/cleanup',{method:'POST',headers:auth(TOKENS.parentA)});
    assert.equal(response.status,403);
    response=await fetch(base+'/api/test/cleanup',{method:'POST',headers:auth(TOKENS.educator)});
    assert.equal(response.status,200);
    assert.deepEqual([...objects.data.keys()],[]);
    assert.deepEqual(await runSyntheticE2E({baseUrl:base,env,
      now:()=>new Date('2026-11-04T12:00:00Z')}),{ok:true,code:'S3_E2E_OK'});
    assert.deepEqual([...objects.data.keys()],[]);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});
