'use strict';

// Lightweight smoke stand: no S3, YDB, Cloudflare, Google Apps Script or
// clinical data is accessed. This isolates Timeweb's runtime/port startup
// from all external dependencies before the S3 hybrid prototype.
const http = require('node:http');

function startSmokeStand(env=process.env) {
  if (env.MEDSI_S3_HYBRID_STAND !== '1') {
    throw new Error('S3_HYBRID_STAND_NOT_ENABLED');
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('S3_HYBRID_INVALID_PORT');
  }
  const server = http.createServer((req,res)=>{
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (req.method==='GET' && (req.url==='/' || req.url==='/index.html')) {
      res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
      res.end('Medsi S3 hybrid test stand online. No patient data connected.');
      return;
    }
    if (req.method==='GET' && req.url?.split('?')[0]==='/__health') {
      res.writeHead(200, {'content-type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        ok:true,service:'medsi-s3-hybrid-smoke',mode:'isolated',
        stage:'runtime-only',storage:'not-connected'
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
  return server;
}

module.exports={startSmokeStand};
