import test from 'node:test';
import assert from 'node:assert/strict';
import {createNextStandApp} from '../src/stand-server.mjs';

const env={MEDSI_NEXT_STAND:'1',NEXT_SESSION_SECRET:'s'.repeat(64),
  NEXT_TUTOR_LOGIN:'staff',NEXT_TUTOR_PASSWORD:'long-fake-test-password',
  NEXT_TUTOR_VERSION:'test-1'};
function fakeServices(){
  return {
    sessions:{verifyWorker:async()=>null,verifyTutor:()=>false,
      loginTutor:()=>({ok:false}),renewTutor:()=>({ok:false})},
    chatStore:{},chatOperations:{},reportReader:{},reports:{},
    dashboard:{},nameVariants:{},passkeys:{},
    parentRegistration:{register:async()=>({ok:true,status:'COMPLETED',parentSession:'dummy'})},
    parentAccess:{request:async()=>({ok:true,status:'PENDING'})},
    parentDeletion:{enqueue:async()=>({ok:true})},
    push:{},dbHealth:async()=>{},
    media:{grantCookie:(_req,_res,next)=>next(),upload:async(_req,res)=>res.status(503).end(),
      open:async(_req,res)=>res.status(404).end()}
  };
}
test('stand refuses to start without explicit isolated mode and tutor credentials',()=>{
  assert.throws(()=>createNextStandApp(fakeServices(),{env:{...env,MEDSI_NEXT_STAND:'0'}}),/explicitly enabled/);
  assert.throws(()=>createNextStandApp(fakeServices(),{env:{...env,NEXT_SESSION_SECRET:'short'}}),/32/);
});
test('stand keeps public entry limited, requires educator auth and closes media by default',async()=>{
  const app=createNextStandApp(fakeServices(),{env});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    let response=await fetch(base+'/__health');
    assert.equal(response.status,200);
    assert.equal((await response.json()).mode,'isolated');

    response=await fetch(base+'/lab/parent-registration',{method:'POST',
      headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,200);
    assert.equal((await response.json()).status,'COMPLETED');

    response=await fetch(base+'/lab/parent-delete',{method:'POST',
      headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,401);

    response=await fetch(base+'/media/s3/secret-file');
    assert.equal(response.status,404);
  }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
