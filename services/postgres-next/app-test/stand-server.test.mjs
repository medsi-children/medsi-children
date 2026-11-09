import test from 'node:test';
import assert from 'node:assert/strict';
import {createNextStandApp,readLegacyAuthConfig,startIsolatedStand,checkNextTestSchema} from '../app/stand-server.mjs';
import {SCHEMA_INDEXES,SCHEMA_TABLES} from '../src/schema-contract.mjs';

const env={MEDSI_NEXT_STAND:'1',MEDSI_NEXT_PG_ENABLED:'1',NEXT_SESSION_SECRET:'s'.repeat(64),
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

test('Timeweb can scan HTTP port before a slow database connection, while data routes fail closed',async()=>{
  let release;
  let destroyed=0;
  const started=await startIsolatedStand({...env,PORT:'0'},{
    connect:()=>new Promise(resolve=>{release=resolve;}),
    prepareChildSchema:async()=>{},verifyChildSchema:async()=>{},
    makeServices:()=>fakeServices(),
    makeApp:(services,options)=>createNextStandApp(services,options)
  });
  if(!started.server.listening){
    await new Promise(resolve=>started.server.once('listening',resolve));
  }
  const base='http://127.0.0.1:'+started.server.address().port;
  try {
    const health=await fetch(base+'/__health');
    assert.equal(health.status,503);
    const body=await health.json();
    assert.equal(body.code,'POSTGRES_CONNECT_PENDING');
    const placeholder=await fetch(base+'/');
    assert.equal(placeholder.status,200);
    assert.match(await placeholder.text(),/test stand online/);
    const blocked=await fetch(base+'/lab/parent-registration',{method:'POST',
      headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(blocked.status,503);
    assert.equal((await blocked.json()).code,'NEXT_STAND_NOT_READY');
    release({sql:{},driver:{destroy:async()=>{destroyed++;}}});
    await started.initialize;
    const ready=await fetch(base+'/__health');
    assert.equal(ready.status,200);
    assert.equal((await ready.json()).database,'reachable');
    assert.equal(started.status.code,'READY');
  }finally{
    await started.shutdown();
    assert.equal(destroyed,1);
  }
});

test('stand exposes safe connection failure status and never uses legacy gateway',async()=>{
  const started=await startIsolatedStand({...env,PORT:'0'},{
    connect:async()=>{throw new Error('PostgreSQL NEXT connection timed out.');}
  });
  try{
    if(!started.server.listening){
      await new Promise(resolve=>started.server.once('listening',resolve));
    }
    await started.initialize;
    const base='http://127.0.0.1:'+started.server.address().port;
    const health=await fetch(base+'/__health');
    assert.equal(health.status,503);
    assert.deepEqual(await health.json(),{
      ok:false,service:'medsi-next',mode:'isolated',database:'unavailable',
      phase:'failed',code:'POSTGRES_CONNECT_FAILED'
    });
    const blocked=await fetch(base+'/tutors');
    assert.equal(blocked.status,503);
  }finally{await started.shutdown();}
});

test('missing test-only secrets are reported on the health endpoint without opening data routes',async()=>{
  const started=await startIsolatedStand({...env,PORT:'0',NEXT_SESSION_SECRET:'short'},
    {connect:async()=>({sql:{},driver:{destroy:async()=>{}}})});
  try{
    if(!started.server.listening){
      await new Promise(resolve=>started.server.once('listening',resolve));
    }
    await started.initialize;
    const base='http://127.0.0.1:'+started.server.address().port;
    const response=await fetch(base+'/__health');
    assert.equal(response.status,503);
    assert.equal((await response.json()).code,'STAND_ENV_INVALID');
  }finally{await started.shutdown();}
});

test('stand identifies invalid authorized-key JSON without displaying its contents',async()=>{
  const started=await startIsolatedStand({...env,PORT:'0'},{
    connect:async()=>{throw new Error('PostgreSQL TLS probe failed.');}
  });
  try{
    if(!started.server.listening)await new Promise(resolve=>started.server.once('listening',resolve));
    await started.initialize;
    const response=await fetch('http://127.0.0.1:'+started.server.address().port+'/__health');
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.code,'POSTGRES_CONNECT_FAILED');
    assert.equal(body.database,'unavailable');
    assert.equal(JSON.stringify(body).includes('private_key'),false);
  }finally{await started.shutdown();}
});

test('stand pinpoints service initialization versus protected router failures',async()=>{
  for(const {breakAt,expected} of [
    {breakAt:'services',expected:'NEXT_SERVICES_INIT_FAILED'},
    {breakAt:'router',expected:'NEXT_ROUTER_INIT_FAILED'}
  ]){
    const started=await startIsolatedStand({...env,PORT:'0'},{
      connect:async()=>({sql:{},driver:{destroy:async()=>{}}}),
      prepareChildSchema:async()=>{},verifyChildSchema:async()=>{},
      makeServices:()=>breakAt==='services'
        ?(()=>{throw new Error('Synthetic service failure');})():fakeServices(),
      makeApp:()=>{throw new Error('Synthetic router failure');}
    });
    try{
      if(!started.server.listening)await new Promise(resolve=>started.server.once('listening',resolve));
      await started.initialize;
      const response=await fetch('http://127.0.0.1:'+started.server.address().port+'/__health');
      assert.equal(response.status,503);
      assert.equal((await response.json()).code,expected);
    }finally{await started.shutdown();}
  }
});

test('stand reports database configuration failures without leaking secrets',async()=>{
  for(const [internalMessage,expected] of [
    ['PostgreSQL TLS probe failed.','POSTGRES_CONNECT_FAILED'],
    ['PostgreSQL NEXT stand mode must be explicitly enabled.','STAND_ENV_INVALID']
  ]){
    const started=await startIsolatedStand({...env,PORT:'0'},{
      connect:async()=>{throw new Error(internalMessage);}
    });
    try{
      if(!started.server.listening)await new Promise(resolve=>started.server.once('listening',resolve));
      await started.initialize;
      const response=await fetch('http://127.0.0.1:'+started.server.address().port+'/__health');
      assert.equal(response.status,503);
      const body=await response.json();
      assert.equal(body.code,expected);
      assert.equal(body.phase,'failed');
      assert.equal(JSON.stringify(body).includes(internalMessage),false);
    }finally{await started.shutdown();}
  }
});


test('database initialization never reveals private connector errors',async()=>{
  const started=await startIsolatedStand({...env,PORT:'0'}, {
    connect:async()=>{throw new Error('synthetic-password-must-not-leak');}
  });
  try{
    if(!started.server.listening)await new Promise(resolve=>started.server.once('listening',resolve));
    await started.initialize;
    const response=await fetch('http://127.0.0.1:'+started.server.address().port+'/__health');
    assert.equal(response.status,503);
    const body=await response.json();
    assert.equal(body.code,'POSTGRES_CONNECT_FAILED');
    assert.equal(JSON.stringify(body).includes('synthetic-password-must-not-leak'),false);
  }finally{
    await started.shutdown();
  }
});

test('isolated PostgreSQL schema probe requires the exact 27 tables and five indexes',async()=>{
  const queries=[];
  const sql=async(parts,...values)=>{
    queries.push({query:parts.join('?'),values});
    if(parts.join('').includes('information_schema.tables'))return [SCHEMA_TABLES.map(table_name=>({table_name}))];
    if(parts.join('').includes('pg_indexes'))return [SCHEMA_INDEXES.map(indexname=>({indexname}))];
    return [[{n:0}]];
  };
  assert.deepEqual(await checkNextTestSchema(sql),{ok:true});
  assert.equal(queries.length,3);
  for(const {query,values} of queries){
    assert.match(query,/^SELECT (?:table_name FROM information_schema\.tables|indexname FROM pg_indexes|count\(\*\)::integer AS n FROM pg_class)/);
    assert.deepEqual(values,[]);
  }
  const incomplete=async(parts)=>parts.join('').includes('information_schema.tables')
    ?[SCHEMA_TABLES.slice(1).map(table_name=>({table_name}))]
    :parts.join('').includes('pg_indexes')?[SCHEMA_INDEXES.map(indexname=>({indexname}))]:[[{n:0}]];
  await assert.rejects(checkNextTestSchema(incomplete),/approved 27-table contract/);
});

test('schema health is separate from DB connectivity and never exposes SQL errors',async()=>{
  const fake=fakeServices();
  fake.dbSchemaHealth=async()=>{throw new Error('hidden schema/table metadata');};
  const app=createNextStandApp(fake,{env});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const root='http://127.0.0.1:'+server.address().port;
  try{
    const health=await fetch(root+'/__health');
    assert.equal(health.status,200);
    const response=await fetch(root+'/__schema-health');
    assert.equal(response.status,503);
    const failed=await response.json();
    assert.equal(failed.code,'PG_TEST_SCHEMA_NOT_READY');
    assert.equal(JSON.stringify(failed).includes('hidden'),false);
    fake.dbSchemaHealth=async()=>({ok:true});
    const recovered=await fetch(root+'/__schema-health');
    assert.equal(recovered.status,200);
    assert.deepEqual(await recovered.json(),{
      ok:true,service:'medsi-next',mode:'isolated',schema:'reachable',checks:8
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
});


test('canonical report routes on Timeweb accept one write and return a PostgreSQL receipt',async()=>{
  const calls=[];
  const services=fakeServices();
  services.sessions.verifyWorker=async token=>token==='fake-educator-session'
    ? {role:'educator',exp:Date.now()+3600000}:null;
  services.reports={
    submit:async input=>{
      calls.push(input);
      return {ok:true,status:'published',publicationId:'synthetic-publication'};
    },
    status:async id=>({status:'completed',result:{ok:true,publicationId:'synthetic-publication',submissionId:id}})
  };
  const app=createNextStandApp(services,{env});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const session={'X-Medsi-Chat-Session':'fake-educator-session'};
  try{
    const payload={text:'Вымышленный текст терапии',reportType:'psychology',
      submissionId:'synthetic_timeweb_report_001'};
    let res=await fetch(base+'/lab/report-submit',{
      method:'POST',headers:{...session,'content-type':'application/json'},
      body:JSON.stringify(payload)
    });
    assert.equal(res.status,200);
    const receipt=await res.json();
    assert.equal(receipt.accepted,true);
    assert.equal(receipt.submissionId,payload.submissionId);
    assert.equal(calls.length,1);
    assert.equal(calls[0].kind,'psychology');

    res=await fetch(base+'/lab/report-submit/status?submissionId='+payload.submissionId,{
      headers:session
    });
    assert.equal(res.status,200);
    const status=await res.json();
    assert.equal(status.status,'completed');
    assert.equal(status.submissionId,payload.submissionId);
    assert.equal(calls.length,1);

    // Missing route must stay 404; never silently forward to a legacy worker.
    res=await fetch(base+'/lab/report-submit-fallback',{
      method:'POST',headers:{...session,'content-type':'application/json'},
      body:JSON.stringify(payload)
    });
    assert.equal(res.status,404);
    assert.equal(calls.length,1);
  }finally{
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
