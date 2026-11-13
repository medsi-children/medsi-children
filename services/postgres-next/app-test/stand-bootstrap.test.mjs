import test from 'node:test';
import assert from 'node:assert/strict';
import bootstrapModule from '../app/stand-bootstrap.cjs';
import {startIsolatedStand,createNextStandApp} from '../app/stand-server.mjs';

const {startStandBootstrap}=bootstrapModule;
const env={MEDSI_NEXT_STAND:'1',MEDSI_NEXT_PG_ENABLED:'1',PORT:'0',
  NEXT_SESSION_SECRET:'s'.repeat(64),NEXT_TUTOR_LOGIN:'staff',
  NEXT_TUTOR_PASSWORD:'test-stand-password',NEXT_TUTOR_VERSION:'test-1'};

const base=server=>'http://127.0.0.1:'+server.address().port;
async function listen(server){
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
}
async function close(server){
  await new Promise(resolve=>server.close(resolve));
}

test('CommonJS preboot serves health before database import; blocked API stays closed',async()=>{
  const b=startStandBootstrap(env);
  try {
    await listen(b.server);
    let response=await fetch(base(b.server)+'/');
    assert.equal(response.status,200);
    assert.match(await response.text(),/NEXT_MODULE_LOADING/);
    response=await fetch(base(b.server)+'/__health');
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'NEXT_MODULE_LOADING');
    response=await fetch(base(b.server)+'/lab/messages',{
      method:'POST',headers:{'content-type':'application/json'},body:'{}'
    });
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'NEXT_STAND_NOT_READY');
    b.fail();
    response=await fetch(base(b.server)+'/__health');
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'NEXT_MODULE_IMPORT_FAILED');
  }finally{await close(b.server);}
});

test('stand handoff reuses the same prebound PM2 port without a second listen',async()=>{
  const b=startStandBootstrap(env);
  await listen(b.server);
  let destroyed=0;
  const fakeServices={
    dbHealth:async()=>{},sessions:{verifyWorker:async()=>null,verifyTutor:()=>false},
    chatStore:{},chatOperations:{},reportReader:{},reports:{},dashboard:{},
    reportHistoryReview:{list:async()=>({ok:true,items:[]}),assign:async()=>({ok:true})},nameVariants:{},
    push:{pendingEvents:async()=>[],deliverEvent:async()=>{}},
    parentRegistration:{},parentAccess:{},parentDeletion:{},passkeys:{},
    media:{grantCookie:(_req,_res,next)=>next(),upload:async(_req,res)=>res.status(503).end(),
      open:async(_req,res)=>res.status(404).end()}
  };
  const beforePort=b.server.address().port;
  const stand=await startIsolatedStand(env,{
    externalServer:b.server,installHandler:b.activate,
    connect:async()=>({sql:{},driver:{destroy:async()=>{destroyed++;}}}),
    prepareChildSchema:async()=>{},verifyChildSchema:async()=>{},
    makeServices:()=>fakeServices,
    makeApp:(services,opts)=>createNextStandApp(services,opts)
  });
  try{
    await stand.initialize;
    assert.equal(stand.server.address().port,beforePort);
    const res=await fetch(base(b.server)+'/__health');
    assert.equal(res.status,200);
    assert.equal((await res.json()).mode,'isolated');
    assert.equal(stand.status.code,'READY');
  }finally{
    await stand.shutdown();
    assert.equal(destroyed,1);
  }
});

test('stand bootstrap refuses production mode and invalid port',()=>{
  assert.throws(()=>startStandBootstrap({MEDSI_NEXT_STAND:'0',PORT:'0'}),/DISABLED/);
  assert.throws(()=>startStandBootstrap({MEDSI_NEXT_STAND:'1',PORT:'65536'}),/INVALID_PORT/);
});
