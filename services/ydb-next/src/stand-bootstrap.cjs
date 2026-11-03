'use strict';

// Timeweb PM2 starts /app/server.js. Bind an HTTP port using ONLY Node.js
// built-ins before importing any NEXT/YDB libraries. If module resolution
// fails in the runtime image, port discovery still works and the stand
// exposes a sanitized diagnostic instead of silently disappearing.
const http=require('node:http');

function startStandBootstrap(env=process.env){
  if(env.MEDSI_NEXT_STAND!=='1')throw new Error('NEXT_BOOTSTRAP_DISABLED');
  const port=Number(env.PORT??3000);
  if(!Number.isInteger(port)||port<0||port>65535){
    throw new Error('NEXT_BOOTSTRAP_INVALID_PORT');
  }
  let delegate=null;
  let code='NEXT_MODULE_LOADING';
  const server=http.createServer((req,res)=>{
    if(delegate)return delegate(req,res);
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    if(req.method==='GET' && (req.url==='/'||req.url==='/index.html')){
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});
      res.end('Medsi NEXT isolated test stand. Startup: '+code);
    }else if(req.method==='GET' && req.url?.split('?')[0]==='/__health'){
      res.writeHead(503,{'content-type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({
        ok:false,service:'medsi-ydb-next',mode:'isolated',
        database:'unavailable',phase:'loading',code
      }));
    }else{
      res.writeHead(503,{'content-type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({ok:false,code:'NEXT_STAND_NOT_READY'}));
    }
  });
  server.on('error',()=>{
    console.error('MEDSI_NEXT_STAND_PORT_BIND_FAILED');
    process.exitCode=1;
  });
  server.listen(port,'0.0.0.0',()=>console.log('MEDSI_NEXT_STAND_HTTP_LISTENING'));
  return {
    server,
    activate(handler){
      if(typeof handler!=='function')throw new Error('NEXT_BOOTSTRAP_INVALID_HANDLER');
      delegate=handler;
    },
    fail(){
      if(delegate)return;
      code='NEXT_MODULE_IMPORT_FAILED';
      console.error('MEDSI_NEXT_STAND_MODULE_IMPORT_FAILED');
    }
  };
}

module.exports={startStandBootstrap};
