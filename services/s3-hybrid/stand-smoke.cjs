'use strict';

// Lightweight smoke stand: no S3, YDB, Cloudflare, Google Apps Script or
// clinical data is accessed. This isolates Timeweb's runtime/port startup
// from all external dependencies before the S3 hybrid prototype.
const http = require('node:http');
const {runS3RoundTripProbe}=require('./live-probe.cjs');

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
  const status={stage:live?'s3-probe':'runtime-only',
    storage:live?'checking':'not-connected'};
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
        ok:true,service:'medsi-s3-hybrid-smoke',mode:'isolated',
        stage:status.stage,storage:status.storage,
        ...(status.code?{code:status.code}:{})
      }));
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
    Promise.resolve().then(()=>probe(env)).then(result=>{
      status.stage=result?.ok?'s3-verified':'s3-failed';
      status.storage=result?.ok?'verified':'unavailable';
      status.code=result?.ok?'S3_PROBE_OK':String(result?.code||'S3_PROBE_FAILED');
      console.log(result?.ok?'MEDSI_S3_PROBE_OK':'MEDSI_S3_PROBE_FAILED');
    }).catch(()=>{
      status.stage='s3-failed';status.storage='unavailable';
      status.code='S3_PROBE_FAILED';
      console.error('MEDSI_S3_PROBE_FAILED');
    });
  }
  return server;
}

module.exports={startSmokeStand};
