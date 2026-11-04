'use strict';

// Lightweight smoke stand: no S3, YDB, Cloudflare, Google Apps Script or
// clinical data is accessed. This isolates Timeweb's runtime/port startup
// from all external dependencies before the S3 hybrid prototype.
const http = require('node:http');
const {runS3RoundTripProbe}=require('./live-probe.cjs');
const {S3Client}=require('@aws-sdk/client-s3');
const {createObjectStore}=require('./object-store.cjs');
const {createTestApi,runSyntheticE2E}=require('./test-api.cjs');

function createOptionalTestApi(env){
  if(env.MEDSI_S3_E2E_API_ENABLED!=='1')return null;
  const bucket=String(env.S3_PROBE_BUCKET||'').trim();
  const accessKeyId=String(env.S3_PROBE_ACCESS_KEY||'').trim();
  const secretAccessKey=String(env.S3_PROBE_SECRET_KEY||'').trim();
  const tokenNames=['S3_STAND_EDUCATOR_TOKEN','S3_STAND_PARENT_A_TOKEN','S3_STAND_PARENT_B_TOKEN'];
  if(env.MEDSI_S3_HYBRID_STAND!=='1'||env.MEDSI_S3_PROBE_ENABLED!=='1'||
      !bucket||bucket===String(env.S3_BUCKET||'').trim()||!accessKeyId||!secretAccessKey||
      tokenNames.some(name=>!/^[a-f0-9]{64}$/.test(String(env[name]||''))))
    throw new Error('S3_E2E_API_CONFIG_INVALID');
  const client=new S3Client({
    endpoint:String(env.S3_PROBE_ENDPOINT||'https://s3.twcstorage.ru').replace(/\/$/,''),
    region:String(env.S3_PROBE_REGION||'ru-1'),forcePathStyle:true,
    credentials:{accessKeyId,secretAccessKey},maxAttempts:2
  });
  const objects=createObjectStore({client,bucket,prefix:'medsi-s3-hybrid-test/v1'});
  return {api:createTestApi({objects,env}),objects,client};
}

function startSmokeStand(env=process.env,{probe=runS3RoundTripProbe}={}) {
  if (env.MEDSI_S3_HYBRID_STAND !== '1') {
    throw new Error('S3_HYBRID_STAND_NOT_ENABLED');
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('S3_HYBRID_INVALID_PORT');
  }
  // Bind HTTP before any S3 I/O so Timeweb port discovery is independent of
  // credentials, IAM, storage latency, and all external services.
  const live=env.MEDSI_S3_PROBE_ENABLED==='1';
  const testApi=live?createOptionalTestApi(env):null;
  if(env.MEDSI_S3_E2E_ENABLED==='1'&&!testApi)
    throw new Error('S3_E2E_API_NOT_ENABLED');
  const status={stage:live?'s3-probe':'runtime-only',
    storage:live?'checking':'not-connected'};
  if(env.MEDSI_S3_E2E_ENABLED==='1')status.e2e='waiting';
  if(live)status.code='S3_PROBE_PENDING';
  const server = http.createServer((req,res)=>{
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (req.method==='GET' && (req.url==='/' || req.url==='/index.html')) {
      res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
      res.end('Medsi S3 hybrid test stand online. No patient data connected. Smoke probe 2026-11-04.');
      return;
    }
    if (req.method==='GET' && req.url?.split('?')[0]==='/__health') {
      res.writeHead(status.stage==='s3-failed'?503:200, {'content-type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        ok:status.stage==='runtime-only'||(status.stage==='s3-verified'&&status.e2e!=='failed'),
        service:'medsi-s3-hybrid-smoke',mode:'isolated',
        stage:status.stage,storage:status.storage,
        ...(testApi?{testApi:'enabled'}:{}),
        ...(status.e2e?{e2e:status.e2e}:{}),
        ...(status.code?{code:status.code}:{})
      }));
      return;
    }
    if(testApi&&req.url?.startsWith('/api/test/')){
      Promise.resolve(testApi.api.handle(req,res)).catch(error=>{
        const statusCode=error?.status===400||error?.status===413?error.status:503;
        if(!res.headersSent){
          res.writeHead(statusCode,{'content-type':'application/json; charset=utf-8'});
          res.end(JSON.stringify({ok:false,code:statusCode===503?'S3_TEST_API_FAILURE':error.message}));
        }
        console.error('S3_TEST_API_REQUEST_FAILED');
      });
      return;
    }
    res.writeHead(404, {'content-type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok:false,code:'NOT_FOUND'}));
  });
  server.on('error', () => {
    console.error('MEDSI_S3_HYBRID_PORT_BIND_FAILED');
    process.exitCode=1;
  });
  server.listen(port,'0.0.0.0',()=>console.log('MEDSI_S3_HYBRID_STAND_LISTENING'));
  if(live) {
    // Fire only with an explicit opt-in and a separate test bucket. No
    // clinical records and no writes to the existing S3_BUCKET.
    Promise.resolve().then(()=>probe(env)).then(async result=>{
      status.stage=result?.ok?'s3-verified':'s3-failed';
      status.storage=result?.ok?'verified':'unavailable';
      const known=new Set(['S3_PROBE_CONFIG_INVALID','S3_PROBE_NAMESPACE_COLLISION',
        'S3_PROBE_WRITE_FAILED','S3_PROBE_READ_MISMATCH',
        'S3_PROBE_IDEMPOTENCY_FAILED','S3_PROBE_CONDITIONAL_UNSUPPORTED',
        'S3_PROBE_OVERWRITE_UNSAFE','S3_PROBE_LIST_FAILED',
        'S3_PROBE_DELETE_FAILED','S3_PROBE_IO_FAILED']);
      status.code=result?.ok?'S3_PROBE_OK':
        known.has(result?.code)?result.code:'S3_PROBE_FAILED';
      console.log(result?.ok?'MEDSI_S3_PROBE_OK':'MEDSI_S3_PROBE_FAILED');
      if(result?.ok&&env.MEDSI_S3_E2E_ENABLED==='1'){
        status.e2e='checking';
        try{
          const scenario=await runSyntheticE2E({
            baseUrl:'http://127.0.0.1:'+port,env
          });
          status.e2e='verified';
          status.code=scenario.code;
          console.log('MEDSI_S3_E2E_OK');
        }catch(error){
          status.e2e='failed';
          const code=String(error?.message||'');
          status.code=/^S3_E2E_[A-Z0-9_]+$/.test(code)?code:'S3_E2E_FAILED';
          console.error(status.code);
        }
      }
    }).catch(()=>{
      status.stage='s3-failed';status.storage='unavailable';
      status.code='S3_PROBE_FAILED';
      console.error('MEDSI_S3_PROBE_FAILED');
    });
  }
  if(testApi)server.once('close',()=>testApi.client.destroy());
  return server;
}

module.exports={startSmokeStand};
