import express from 'express';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {connectYdbNext} from './connection.mjs';
import {createSessionService} from './session-auth.mjs';
import {createReportReader} from './report-reader.mjs';
import {createReportSubmissionService} from './report-submission-service.mjs';
import {createChatStore} from './chat-store.mjs';
import {createChatOperations} from './chat-operations.mjs';
import {createEducatorReportsDashboardStore} from './educator-report-dashboard.mjs';
import {createNameVariantsStore} from './name-variants-store.mjs';
import {createPushService} from './push-service.mjs';
import {createParentPasskeyService} from './parent-passkeys.mjs';
import {createParentAccessService} from './parent-access.mjs';
import {createParentRegistrationService} from './parent-registration.mjs';
import {createParentDeletionService} from './parent-deletion.mjs';
import {createMediaService} from './media-service.mjs';
import {createNextLabRouter} from './api-router.mjs';
import {createLegacyBridge} from './legacy-bridge.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(import.meta.url);
const phone10=value=>String(value||'').replace(/\D/g,'').slice(-10);
const PHONE=/^\d{10}$/;
const PUBLIC_ASSETS=[
  '/favicon.ico','/apple-touch-icon.png','/apple-touch-icon2.png',
  '/manifest.json','/tutors-manifest.json','/sw.js'
];

function requireEnv(env) {
  // Stands are opt-in, never silently connect to a production Cloudflare or
  // Apps Script proxy when YDB is absent or credentials are missing.
  if(env.MEDSI_NEXT_STAND!=='1')throw new Error('Isolated YDB stand mode must be explicitly enabled.');
  for(const field of ['NEXT_SESSION_SECRET','NEXT_TUTOR_LOGIN','NEXT_TUTOR_PASSWORD','NEXT_TUTOR_VERSION']){
    if(!String(env[field]||'').trim())throw new Error('NEXT stand missing '+field);
  }
  if(String(env.NEXT_SESSION_SECRET).length<32)throw new Error('NEXT session secret must be at least 32 characters.');
}
// Disabled by default; enable only after clinical identity and push capture audit.
// A partial config is unsafe: it would silently log out some existing devices.
export function readLegacyAuthConfig(env) {
  if(env.MEDSI_NEXT_LEGACY_AUTH_ENABLED!=='1')return {};
  const fields=[
    'NEXT_LEGACY_D1_SESSION_SECRET','NEXT_LEGACY_TUTOR_LOGIN',
    'NEXT_LEGACY_TUTOR_PASSWORD','NEXT_LEGACY_TUTOR_VERSION'
  ];
  if(fields.some(field=>!String(env[field]||'').trim()) ||
     String(env.NEXT_LEGACY_D1_SESSION_SECRET).length<32) {
    throw new Error('Incomplete legacy identity migration credentials.');
  }
  return {
    legacyWorkerSecret:env.NEXT_LEGACY_D1_SESSION_SECRET,
    legacyTutor:{login:env.NEXT_LEGACY_TUTOR_LOGIN,
      password:env.NEXT_LEGACY_TUTOR_PASSWORD,
      version:env.NEXT_LEGACY_TUTOR_VERSION}
  };
}
export function createNextServices({sql,env=process.env}) {
  requireEnv(env);
  const sessions=createSessionService({
    sql,secret:env.NEXT_SESSION_SECRET,login:env.NEXT_TUTOR_LOGIN,
    password:env.NEXT_TUTOR_PASSWORD,tutorVersion:env.NEXT_TUTOR_VERSION,
    ...readLegacyAuthConfig(env)
  });
  const reportReader=createReportReader(sql),reports=createReportSubmissionService(sql);
  const chatOperations=createChatOperations(sql),chatStore=createChatStore(sql);
  const dashboard=createEducatorReportsDashboardStore(sql),nameVariants=createNameVariantsStore(sql);
  const push=createPushService({sql,env});
  const parentRegistration=createParentRegistrationService({sql,sessions});
  const parentAccess=createParentAccessService({sql,sessions});
  const parentDeletion=createParentDeletionService({sql,
    enabled:env.MEDSI_NEXT_DELETION_ENABLED==='1',
    removeMedia:async key=>{
      const storage=require('../../../lib/s3-storage.js');
      if(!storage.configured)throw new Error('Private S3 storage is not configured.');
      await storage.removeObject(key);
    }
  });
  const passkeys=env.PARENT_PASSKEY_RP_ID&&env.PARENT_PASSKEY_ORIGIN
    ?createParentPasskeyService({sql,sessions,env})
    :Object.fromEntries(['authenticationOptions','authenticationVerify','hasPasskey',
       'registrationOptions','registrationVerify'].map(method=>[method,
      async()=>{throw new Error('Passkeys unavailable until origin and RP ID are configured.');}]));
  const media=createMediaService({sql,sessions,secret:env.NEXT_SESSION_SECRET,
    storage:require('../../../lib/s3-storage.js')});
  const dbHealth=async()=>{await sql`SELECT 1 AS connected`;};
  return {sessions,reportReader,reports,chatOperations,chatStore,dashboard,
    nameVariants,push,parentRegistration,parentAccess,parentDeletion,passkeys,dbHealth,media};
}

function handler(fn) {
  return async(req,res)=>{
    try {
      const result=await fn(req,res);
      if(!res.headersSent&&result!==undefined)res.json(result);
    }catch(error) {
      const userError=/^(Invalid |Unauthorized|Unsupported |Parent profile|Request |Forbidden)/.test(String(error?.message||''));
      if(!res.headersSent)res.status(userError?400:503).json({ok:false,
        message:userError?'Некорректный или недоступный запрос.':'Сервис временно недоступен.'});
    }
  };
}
export function createNextStandApp(services,{env=process.env,root=ROOT}={}) {
  requireEnv(env);
  const app=express();
  app.disable('x-powered-by');
  app.use((_req,res,next)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    next();
  });
  app.get('/__health',handler(async()=>{
    if(typeof services.dbHealth!=='function')throw new Error('YDB health probe unavailable.');
    await services.dbHealth();
    return {ok:true,service:'medsi-ydb-next',mode:'isolated',database:'reachable'};
  }));

  const legacy=createLegacyBridge({
    sessions:services.sessions,reportReader:services.reportReader,
    chatOperations:services.chatOperations,reportSubmission:services.reports,
    parentRegistration:services.parentRegistration,parentAccess:services.parentAccess
  });
  app.post('/__session/apps-script',express.text({type:'*/*',limit:'64kb'}),handler(async req=>{
    let payload;
    try{payload=JSON.parse(String(req.body||''));}catch(_){throw new Error('Invalid legacy payload.');}
    if(payload?.action!=='api')throw new Error('Invalid legacy action.');
    return {ok:true,result:await legacy(payload.method,payload.args||[])};
  }));
  if(!services.media?.grantCookie||!services.media?.upload||!services.media?.open){
    throw new Error('Protected media backend must be present before standing up the app.');
  }
  app.use('/lab',services.media.grantCookie,createNextLabRouter(services));

  // Web Push is authorized at this same origin. The legacy push worker is
  // deliberately never contacted in isolated stand mode.
  const push=express.Router();
  push.use(express.text({type:'*/*',limit:'64kb'}));
  async function pushAuth(payload) {
    if(payload.role==='parent'){
      const phone=phone10(payload.phone);
      const auth=await services.sessions.verifyWorker(String(payload.parentSession||''));
      if(!PHONE.test(phone)||!auth||auth.role!=='parent'||auth.phone10!==phone||auth.preview) {
        throw new Error('Unauthorized.');
      }
      return {role:'parent',phone10:phone};
    }
    if(payload.role==='educator'&&services.sessions.verifyTutor(String(payload.tutorToken||''))){
      return {role:'educator',phone10:''};
    }
    throw new Error('Unauthorized.');
  }
  const parsePayload=req=>{
    let data;
    try{data=JSON.parse(String(req.body||'{}'));}catch(_){throw new Error('Invalid push payload.');}
    return data;
  };
  push.post('/subscribe',handler(async req=>{
    const data=parsePayload(req),auth=await pushAuth(data);
    return services.push.subscribe({...auth,subscription:data.subscription});
  }));
  push.post('/unsubscribe',handler(async req=>{
    const data=parsePayload(req),auth=await pushAuth(data);
    return services.push.unsubscribe({...auth,endpoint:data.endpoint});
  }));
  app.use('/push',push);
  // Media is private: chat headers authorize upload; short-lived HttpOnly
  // cookie + active chat-message ownership authorizes browser image loading.
  app.post('/chat-upload',handler((req,res)=>services.media.upload(req,res)));
  app.get('/media/s3/:key',handler((req,res)=>services.media.open(req,res)));
  app.all('/media/*path',(_req,res)=>res.status(404).end());
  app.all(['/lab/bot-log','/__bot-log-view'],(_req,res)=>res.status(410).json({ok:false}));

  // Replace the hard-coded old VAPID public key at runtime. Never send a
  // secret or VAPID private key in a browser script.
  app.get('/notify-client.js',handler(async (_req,res)=>{
    const script=await readFile(path.join(root,'notify-client.js'),'utf8');
    const pub=String(env.VAPID_PUBLIC_KEY||'');
    const updated=pub
      ?script.replace(/const VAPID_PUBLIC_KEY = '[^']*';/,
        'const VAPID_PUBLIC_KEY = '+JSON.stringify(pub)+';'):script;
    res.type('application/javascript').send(updated);
  }));
  const send=(file)=> (_req,res)=>res.sendFile(path.join(root,file));
  app.get(['/','/index.html'],send('index.html'));
  app.get(['/tutors','/tutors/','/tutors.html'],send('tutors.html'));
  app.get(['/psychology','/psychology/','/psychology.html'],send('psychology.html'));
  const opt={dotfiles:'ignore',index:false,etag:true,maxAge:0};
  for(const dir of ['parents','chat-overlay','tutors','psychology']){
    app.use('/'+dir,express.static(path.join(root,dir),opt));
  }
  app.get(PUBLIC_ASSETS,express.static(root,opt));
  app.use((_req,res)=>res.status(404).end());
  return app;
}

// This is a stand-only bootstrap listener. Timeweb scans for an open port
// while YDB credentials/connectivity are being checked, so the port must
// open before any network I/O. All data routes fail closed until NEXT is ready.
export async function startIsolatedStand(env=process.env,{
  connect=connectYdbNext,
  makeServices=createNextServices,
  makeApp=createNextStandApp,
  externalServer=null,
  installHandler=null
}={}) {
  if(env.MEDSI_NEXT_STAND!=='1') {
    throw new Error('Isolated YDB stand mode must be explicitly enabled.');
  }
  const state={phase:'connecting',code:'YDB_CONNECT_PENDING'};
  let backend=null,driver=null,ticker=null,stopped=false,working=false;
  const app=express();
  app.disable('x-powered-by');
  app.use((_req,res,next)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    next();
  });
  app.get('/__health',(req,res)=>{
    if(backend)return backend(req,res);
    return res.status(503).json({
      ok:false,service:'medsi-ydb-next',mode:'isolated',
      database:'unavailable',phase:state.phase,code:state.code
    });
  });
  app.use((req,res,next)=>{
    if(backend)return backend(req,res,next);
    // The platform probes HTTP / while discovering a newly created stand.
    // A safe 200 placeholder signals a live Node.js process; /__health
    // continues to return a truthful 503 until YDB and services are ready.
    if(req.method==='GET' && (req.path==='/'||req.path==='/index.html')) {
      return res.status(200).type('text/plain; charset=utf-8')
        .send('Medsi NEXT test stand online. YDB status: '+state.code);
    }
    return res.status(503).json({
      ok:false,code:'NEXT_STAND_NOT_READY',phase:state.phase
    });
  });
  const port=Number(env.PORT??3000);
  // In Timeweb, the dependency-free CommonJS bootstrap has already bound
  // the port. Attach the protected Express router to that SAME server.
  if(Boolean(externalServer)!==Boolean(installHandler)){
    throw new Error('NEXT standalone HTTP handoff must be complete.');
  }
  const server=externalServer||app.listen(port,'0.0.0.0',()=>{
    console.log('MEDSI_NEXT_STAND_HTTP_LISTENING');
  });
  if(externalServer)installHandler(app);
  const shutdown=async()=>{
    stopped=true;
    if(ticker)clearInterval(ticker);
    await new Promise(resolve=>server.close(resolve));
    if(typeof driver?.destroy==='function')await driver.destroy().catch(()=>{});
  };
  process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
  process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});

  const initialize=(async()=>{
    let connection=null;
    try{
      requireEnv(env);
      state.code='YDB_CONNECT_PENDING';
      connection=await connect(env);
      if(stopped){
        if(typeof connection?.driver?.destroy==='function')
          await connection.driver.destroy().catch(()=>{});
        return;
      }
      driver=connection.driver;
      state.code='NEXT_SERVICES_PENDING';
      const services=makeServices({sql:connection.sql,env});
      state.code='NEXT_ROUTER_PENDING';
      const actualApp=makeApp(services,{env});
      // Backend only becomes visible once its entire security middleware,
      // sessions, and routes have been constructed successfully.
      backend=actualApp;
      state.phase='ready';
      state.code='READY';
      console.log('MEDSI_NEXT_STAND_READY');
      ticker=setInterval(async()=>{
        if(working||stopped)return;
        working=true;
        try{
          const ids=await services.push.pendingEvents(20);
          for(const id of ids)await services.push.deliverEvent(id);
          if(env.MEDSI_NEXT_DELETION_ENABLED==='1'){
            const cleanup=await services.parentDeletion.processNext();
            if(cleanup.ok===false)console.warn('NEXT_PARENT_DELETION_RETRY_REQUIRED');
          }
        }catch(_){
          console.warn('NEXT_PUSH_DISPATCH_UNAVAILABLE');
        }finally{working=false;}
      },30000);
      ticker.unref();
    }catch(error){
      // No raw errors: they can contain connection strings, service-account
      // metadata or data from patients. Stable labels are safe for operators.
      const msg=String(error?.message||'');
      const failedAt=state.code;
      const code=msg.includes('NEXT stand missing') ||
        msg.includes('NEXT session secret') ||
        msg.includes('isolated mode must') ?'STAND_ENV_INVALID'
        :msg.includes('encrypted Yandex YDB Serverless endpoint')
        ?'YDB_ENDPOINT_INVALID'
        :msg.includes('YDB_SERVICE_ACCOUNT_JSON is missing or invalid')
        ?'YDB_SERVICE_ACCOUNT_JSON_INVALID'
        :msg.includes('service account JSON')||msg.includes('authorized-key fields')
        ?'YDB_SERVICE_ACCOUNT_INVALID'
        :msg.includes('Incomplete legacy identity migration credentials')
        ?'STAND_LEGACY_AUTH_INVALID'
        :msg.includes('explicit test table scope') ||
         msg.includes('Unrecognized YDB table scope')
        ?'YDB_TEST_SCOPE_INVALID'
        :msg.includes('YDB NEXT is disabled')?'YDB_DISABLED'
        :msg.includes('YDB NEXT connection timed out')?'YDB_CONNECT_TIMEOUT'
        :msg.includes('YDB NEXT connection failed')?'YDB_CONNECT_FAILED'
        :msg.includes('YDB NEXT configuration validation failed')?'YDB_CONFIG_VALIDATION_FAILED'
        :msg.includes('YDB NEXT credentials provider initialization failed')?'YDB_AUTH_PROVIDER_INIT_FAILED'
        :msg.includes('YDB NEXT driver initialization failed')?'YDB_DRIVER_INIT_FAILED'
        :failedAt==='YDB_CONNECT_PENDING'?'YDB_CLIENT_INIT_FAILED'
        :failedAt==='NEXT_SERVICES_PENDING'?'NEXT_SERVICES_INIT_FAILED'
        :failedAt==='NEXT_ROUTER_PENDING'?'NEXT_ROUTER_INIT_FAILED'
        :'NEXT_STARTUP_FAILED';
      state.phase='failed';
      state.code=code;
      console.error('MEDSI_NEXT_STAND_BOOT_FAILED:',code);
      if(typeof driver?.destroy==='function')await driver.destroy().catch(()=>{});
      driver=null;
    }
  })();
  return {app,server,get services(){return backend?true:null;},
    get status(){return {...state};},initialize,shutdown};
}
