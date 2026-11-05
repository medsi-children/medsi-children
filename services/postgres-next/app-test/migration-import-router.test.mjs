import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createMigrationImportRouter} from '../app/migration-import-router.mjs';

async function withServer(router,fn){
  const app=express();app.use('/__migration/import',router);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try{return await fn(`http://127.0.0.1:${server.address().port}/__migration/import`)}
  finally{await new Promise(resolve=>server.close(resolve))}
}

test('migration import is hidden without protected keys and rejects missing explicit freeze/import headers',async()=>{
  const token='synthetic-token-'.repeat(4),audit='synthetic-audit-key-'.repeat(4);
  await withServer(createMigrationImportRouter({sql:async()=>{},storage:{configured:true},env:{}}),async url=>{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,404);
  });
  await withServer(createMigrationImportRouter({sql:async()=>{},storage:{configured:true},env:{
    MEDSI_MIGRATION_IMPORT_TOKEN:token,MEDSI_MIGRATION_AUDIT_KEY:audit
  }}),async url=>{
    const wrong=await fetch(url,{method:'POST',headers:{authorization:'Bearer wrong-token',
      'content-type':'application/json'},body:'{}'});
    assert.equal(wrong.status,404);
    const missing=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,
      'content-type':'application/json'},body:'{}'});
    assert.equal(missing.status,400);
    assert.deepEqual(await missing.json(),{ok:false,code:'MIGRATION_CONFIRMATION_REQUIRED'});
  });
});

test('protected inventory reads existing S3 objects without freeze, SQL writes or secret disclosure',async()=>{
 let writes=0;const token='synthetic-token-'.repeat(4),audit='synthetic-audit-key-'.repeat(4);
 const router=createMigrationImportRouter({sql:async()=>{writes++;throw new Error();},env:{
 MEDSI_MIGRATION_IMPORT_TOKEN:token,MEDSI_MIGRATION_AUDIT_KEY:audit,VAPID_PUBLIC_KEY:'synthetic-public'},
 storage:{configured:true,getObject:async()=>({Body:(async function*(){yield Buffer.from('synthetic-object')})()})}});
 await withServer(router,async url=>{
 const hidden=await fetch(url+'/inventory',{method:'POST',headers:{'content-type':'application/json'},body:'{"fileIds":[]}'});
 assert.equal(hidden.status,404);
 const response=await fetch(url+'/inventory',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({fileIds:['s3:chat/'+ 'a'.repeat(64)+'.jpg']})});
 assert.equal(response.status,200);const data=await response.json();assert.equal(data.objects.length,1);
 assert.equal(data.objects[0].bytes,16);assert.match(data.objects[0].sha256,/^[a-f0-9]{64}$/);
 assert.equal(data.vapidPublicKey,'synthetic-public');assert.equal(writes,0);
 const invalid=await fetch(url+'/inventory',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"fileIds":["s3:../secret"]}'});
 assert.equal(invalid.status,409);
 });
});
