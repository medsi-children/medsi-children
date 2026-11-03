import test from 'node:test';
import assert from 'node:assert/strict';
import {createNextStandApp,readLegacyAuthConfig} from '../src/stand-server.mjs';

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

test('legacy browser request envelope remains compatible for tutor login and rejects old writes',async()=>{
  const services=fakeServices();
  services.sessions.verifyTutor=token=>token==='valid-tutor';
  services.sessions.loginTutor=(login,password)=>login==='staff'&&password==='synthetic-pass'
    ?{ok:true,token:'valid-tutor'}:{ok:false,message:'Bad credentials'};
  services.sessions.issueEducator=()=>({token:'fake-educator-session',expiresAt:Date.now()+300000});
  services.chatOperations.listParents=async()=>({ok:true,parents:[]});
  const app=createNextStandApp(services,{env});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function call(method,args){
    const response=await fetch(base+'/__session/apps-script',{
      method:'POST',
      headers:{'content-type':'text/plain;charset=UTF-8'},
      body:JSON.stringify({action:'api',method,args})
    });
    return {status:response.status,body:await response.json()};
  }
  try{
    const login=await call('verifyTutorAccess',['staff','synthetic-pass']);
    assert.equal(login.status,200);
    assert.equal(login.body.ok,true);
    assert.equal(login.body.result.token,'valid-tutor');

    const parents=await call('listAvailableParentsForChat',['valid-tutor']);
    assert.equal(parents.status,200);
    assert.deepEqual(parents.body.result,{ok:true,parents:[]});

    const rejected=await call('deleteReportChildByPhone',['89990000001','valid-tutor']);
    assert.equal(rejected.status,400);
    assert.equal(rejected.body.ok,false);
    assert.equal(Object.hasOwn(rejected.body,'result'),false);
  }finally{
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});

test('legacy continuity cannot activate accidentally or with partial signing credentials',()=>{
  assert.deepEqual(readLegacyAuthConfig({}),{});
  assert.deepEqual(readLegacyAuthConfig({NEXT_LEGACY_D1_SESSION_SECRET:'secret-exists'}),{});
  assert.throws(()=>readLegacyAuthConfig({
    MEDSI_NEXT_LEGACY_AUTH_ENABLED:'1',NEXT_LEGACY_D1_SESSION_SECRET:'fake'
  }),/Incomplete legacy/);
  const result=readLegacyAuthConfig({
    MEDSI_NEXT_LEGACY_AUTH_ENABLED:'1',
    NEXT_LEGACY_D1_SESSION_SECRET:'x'.repeat(64),
    NEXT_LEGACY_TUTOR_LOGIN:'old-staff',
    NEXT_LEGACY_TUTOR_PASSWORD:'old-synthetic-password',
    NEXT_LEGACY_TUTOR_VERSION:'old-version'
  });
  assert.equal(result.legacyWorkerSecret.length,64);
  assert.equal(result.legacyTutor.version,'old-version');
});
