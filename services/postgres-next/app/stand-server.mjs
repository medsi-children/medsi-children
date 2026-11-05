import express from 'express';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
// PostgreSQL is the only database connector accepted by the NEXT runtime.
async function closeDatabaseDriver(driver) {
  const closer=typeof driver?.close==='function' ? ()=>driver.close()
    :typeof driver?.destroy==='function' ? ()=>driver.destroy():null;
  if(!closer)return;
  let timer;
  try{
    await Promise.race([
      Promise.resolve().then(closer).catch(()=>{}),
      new Promise(resolve=>{
        timer=setTimeout(resolve,3000);
        timer.unref?.();
      })
    ]);
  }finally{if(timer)clearTimeout(timer);}
}
import {createSessionService} from './session-auth.mjs';
import {createReportReader} from './report-reader.mjs';
import {createReportSubmissionService} from './report-submission-service.mjs';
import {createChatStore} from './chat-store.mjs';
import {createChatOperations} from './chat-operations.mjs';
import {createEducatorReportsDashboardStore} from './educator-report-dashboard.mjs';
import {createEducatorRosterStore} from './educator-roster.mjs';
import {createEducatorReportEditsStore} from './educator-report-edits.mjs';
import {createNameVariantsStore} from './name-variants-store.mjs';
import {createPushService} from './push-service.mjs';
import {createParentPasskeyService} from './parent-passkeys.mjs';
import {createParentAccessService} from './parent-access.mjs';
import {createParentRegistrationService} from './parent-registration.mjs';
import {createParentDeletionService} from './parent-deletion.mjs';
import {createMediaService} from './media-service.mjs';
import {createNextLabRouter} from './api-router.mjs';
import {createLegacyBridge} from './legacy-bridge.mjs';
import {createMigrationImportRouter} from './migration-import-router.mjs';
import {schemaMatches} from '../src/schema-contract.mjs';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(import.meta.url);
const phone10=value=>String(value||'').replace(/\D/g,'').slice(-10);
const PHONE=/^\d{10}$/;
const PUBLIC_ASSETS=[
  '/favicon.ico','/apple-touch-icon.png','/apple-touch-icon2.png',
  '/manifest.json','/tutors-manifest.json','/sw.js'
];

function requireEnv(env) {
  // The PostgreSQL stand is opt-in and never falls back to a legacy proxy.
  if(env.MEDSI_NEXT_STAND!=='1' || env.MEDSI_NEXT_PG_ENABLED!=='1')
    throw new Error('PostgreSQL NEXT stand mode must be explicitly enabled.');
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
// Read-only schema probe for the isolated test stand.
// LIMIT 0 validates table/column resolution without reading patient rows.
export async function checkNextTestSchema(sql) {
  if(typeof sql!=='function')throw new Error('PostgreSQL query adapter unavailable.');
  const [[tables],[indexes],[otherRelations]] = await Promise.all([
    sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'`,
    sql`SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
    sql`SELECT count(*)::integer AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('public','pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp_%'
        AND n.nspname NOT LIKE 'pg_toast_temp_%'
        AND c.relkind IN ('r','p','v','m','S','f','i','I')`
  ]);
  if(!schemaMatches(tables.map(row=>row.table_name),
      indexes.map(row=>row.indexname),otherRelations[0]?.n)){
    throw new Error('PostgreSQL schema does not match the approved 27-table contract.');
  }
  return {ok:true};
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
  const dashboard=createEducatorReportsDashboardStore(sql),roster=createEducatorRosterStore(sql),nameVariants=createNameVariantsStore(sql);
  const reportEdits=createEducatorReportEditsStore(sql);
  const push=createPushService({sql,env});
  const parentRegistration=createParentRegistrationService({sql,sessions});
  const parentAccess=createParentAccessService({sql,sessions});
  const storage=require('../../../lib/s3-storage.js');
  const parentDeletion=createParentDeletionService({sql,
    enabled:env.MEDSI_NEXT_DELETION_ENABLED==='1',
    removeMedia:async key=>{
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
    storage});
  const dbHealth=async()=>{await sql`SELECT 1 AS connected`;};
  const dbSchemaHealth=()=>checkNextTestSchema(sql);
  return {sessions,reportReader,reports,chatOperations,chatStore,dashboard,roster,
    nameVariants,reportEdits,push,parentRegistration,parentAccess,parentDeletion,passkeys,dbHealth,dbSchemaHealth,media,sql,storage};
}

function handler(fn) {
  return async(req,res)=>{
    try {
      const result=await fn(req,res);
      if(!res.headersSent&&result!==undefined)res.json(result);
    }catch(error) {
      const message=String(error?.message||'');
      const unauthorized=/^Unauthorized/.test(message);
      const expired=error?.code==='PUSH_SUBSCRIPTION_EXPIRED';
      const forbidden=/^(Forbidden|Subscription belongs)/.test(message);
      const userError=/^(Invalid |Unauthorized|Unsupported |Parent profile|Request |Forbidden|Subscription belongs)/.test(message);
      if(!res.headersSent)res.status(expired?409:unauthorized?401:forbidden?403:userError?400:503).json({
        ok:false,...(expired?{code:'PUSH_SUBSCRIPTION_EXPIRED'}:{}),
        message:expired?'Подписка устарела, требуется обновление.':userError
          ?'Некорректный или недоступный запрос.':'Сервис временно недоступен.'
      });
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
    if(typeof services.dbHealth!=='function')throw new Error('PostgreSQL health probe unavailable.');
    await services.dbHealth();
    return {ok:true,service:'medsi-next',mode:'isolated',database:'reachable'};
  }));

  // Separate from /__health: DB connectivity can succeed even without schema.
  // No patient data, schema errors or query text are included in the response.
  app.get('/__schema-health',async(_req,res)=>{
    if(typeof services.dbSchemaHealth!=='function') {
      return res.status(503).json({ok:false,service:'medsi-next',
        mode:'isolated',schema:'unavailable',code:'PG_TEST_SCHEMA_UNAVAILABLE'});
    }
    try{
      await services.dbSchemaHealth();
      return res.json({ok:true,service:'medsi-next',mode:'isolated',
        schema:'reachable',checks:8});
    }catch(_){
      return res.status(503).json({ok:false,service:'medsi-next',
        mode:'isolated',schema:'unavailable',code:'PG_TEST_SCHEMA_NOT_READY'});
    }
  });

  const legacy=createLegacyBridge({
    sessions:services.sessions,reportReader:services.reportReader,
    chatOperations:services.chatOperations,reportSubmission:services.reports,
    parentRegistration:services.parentRegistration,parentAccess:services.parentAccess
  });
  app.use('/__migration/import',createMigrationImportRouter({sql:services.sql,storage:services.storage,env}));
  app.post(['/__session/api','/__session/apps-script'],express.text({type:'*/*',limit:'64kb'}),handler(async req=>{
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
    return services.push.unsubscribe({...auth,endpoint:data.endpoint,reason:data.reason});
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
    // A missing current VAPID configuration must never expose a stale
    // hard-coded key from the previous push infrastructure.
    const updated=script.replace(/const VAPID_PUBLIC_KEY = '[^']*';/,
      'const VAPID_PUBLIC_KEY = '+JSON.stringify(pub)+';');
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
// while PostgreSQL connectivity is being checked, so the port must
// open before any network I/O. All data routes fail closed until NEXT is ready.
export async function startIsolatedStand(env=process.env,{
  connect,
  makeServices=createNextServices,
  makeApp=createNextStandApp,
  externalServer=null,
  installHandler=null
}={}) {
  if(env.MEDSI_NEXT_STAND!=='1' || env.MEDSI_NEXT_PG_ENABLED!=='1' || typeof connect!=='function') {
    throw new Error('PostgreSQL NEXT stand mode and connector must be explicitly enabled.');
  }
  const state={phase:'connecting',code:'POSTGRES_CONNECT_PENDING'};
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
      ok:false,service:'medsi-next',mode:'isolated',
      database:'unavailable',phase:state.phase,code:state.code
    });
  });
  app.use((req,res,next)=>{
    if(backend)return backend(req,res,next);
    // The platform probes HTTP / while discovering a newly created stand.
    // A safe 200 placeholder signals a live Node.js process; /__health
    // continues to return a truthful 503 until PostgreSQL and services are ready.
    if(req.method==='GET' && (req.path==='/'||req.path==='/index.html')) {
      return res.status(200).type('text/plain; charset=utf-8')
        .send('Medsi NEXT test stand online. Database status: '+state.code);
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
    await closeDatabaseDriver(driver);
  };
  process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
  process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});

  const initialize=(async()=>{
    let connection=null;
    try{
      requireEnv(env);
      state.code='POSTGRES_CONNECT_PENDING';
      connection=await connect(env);
      if(stopped){
        await closeDatabaseDriver(connection?.driver);
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
      // Report the catalog-only schema check even if the public endpoint is unreachable.
      if(typeof services.dbSchemaHealth==='function'){
        void Promise.resolve().then(()=>services.dbSchemaHealth()).then(
          ()=>console.log('MEDSI_NEXT_SCHEMA_READY'),
          async()=>{
            try{
              const [rows]=await connection.sql`
                SELECT count(*)::integer AS relation_count
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE n.nspname NOT IN ('pg_catalog','information_schema')
                  AND n.nspname NOT LIKE 'pg_toast%'
                  AND n.nspname NOT LIKE 'pg_temp_%'
                  AND c.relkind IN ('r','p','v','m','S','f','i','I')
              `;
              const count=rows[0]?.relation_count;
              if(Number.isSafeInteger(count)&&count>=0){
                console.warn('MEDSI_NEXT_SCHEMA_NOT_READY relation_count='+count);
                return;
              }
            }catch(_){
              // Never write database error details to the application log.
            }
            console.warn('MEDSI_NEXT_SCHEMA_CATALOG_UNAVAILABLE');
          }
        );
      }
      const dispatchPush=env.MEDSI_NEXT_PUSH_DISPATCH_ENABLED==='1';
      const processDeletion=env.MEDSI_NEXT_DELETION_ENABLED==='1';
      if(dispatchPush||processDeletion){
        ticker=setInterval(async()=>{
          if(working||stopped)return;
          working=true;
          try{
            if(dispatchPush){
              const ids=await services.push.pendingEvents(20);
              for(const id of ids)await services.push.deliverEvent(id);
            }
            if(processDeletion){
              const cleanup=await services.parentDeletion.processNext();
              if(cleanup.ok===false)console.warn('NEXT_PARENT_DELETION_RETRY_REQUIRED');
            }
          }catch(_){
            console.warn('NEXT_BACKGROUND_JOBS_UNAVAILABLE');
          }finally{working=false;}
        },30000);
        ticker.unref();
      }
    }catch(error){
      // No raw errors: they can contain connection strings or patient data.
      const msg=String(error?.message||'');
      const failedAt=state.code;
      const code=msg.includes('PostgreSQL NEXT stand mode') ||
        msg.includes('NEXT stand missing') ||
        msg.includes('NEXT session secret') ||
        msg.includes('stand mode and connector') ?'STAND_ENV_INVALID'
        :msg.includes('Incomplete legacy identity migration credentials')
        ?'STAND_LEGACY_AUTH_INVALID'
        :msg.includes('PostgreSQL TLS probe failed')?'POSTGRES_CONNECT_FAILED'
        :failedAt==='POSTGRES_CONNECT_PENDING'?'POSTGRES_CONNECT_FAILED'
        :failedAt==='NEXT_SERVICES_PENDING'?'NEXT_SERVICES_INIT_FAILED'
        :failedAt==='NEXT_ROUTER_PENDING'?'NEXT_ROUTER_INIT_FAILED'
        :'NEXT_STARTUP_FAILED';
      state.phase='failed';
      state.code=code;
      console.error('MEDSI_NEXT_STAND_BOOT_FAILED:',code);
      await closeDatabaseDriver(driver);
      driver=null;
    }
  })();
  return {app,server,get services(){return backend?true:null;},
    get status(){return {...state};},initialize,shutdown};
}
