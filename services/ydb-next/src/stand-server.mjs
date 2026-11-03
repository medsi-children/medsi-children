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
export function createNextServices({sql,env=process.env}) {
  requireEnv(env);
  const sessions=createSessionService({
    sql,secret:env.NEXT_SESSION_SECRET,login:env.NEXT_TUTOR_LOGIN,
    password:env.NEXT_TUTOR_PASSWORD,tutorVersion:env.NEXT_TUTOR_VERSION
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

export async function startIsolatedStand(env=process.env) {
  requireEnv(env);
  const {sql,driver}=await connectYdbNext(env);
  const services=createNextServices({sql,env});
  const app=createNextStandApp(services,{env});
  const port=Number(env.PORT||3000);
  const server=app.listen(port,'0.0.0.0',()=>{
    console.log('Medsi YDB isolated stand listening');
  });
  let working=false;
  const ticker=setInterval(async()=>{
    if(working)return;
    working=true;
    try{
      const ids=await services.push.pendingEvents(20);
      for(const id of ids)await services.push.deliverEvent(id);
      if(env.MEDSI_NEXT_DELETION_ENABLED==='1'){
        const cleanup=await services.parentDeletion.processNext();
        if(cleanup.ok===false)console.warn('NEXT_PARENT_DELETION_RETRY_REQUIRED');
      }
    }catch(_){
      // A failed notification cannot stop reports or chat.
      console.warn('NEXT_PUSH_DISPATCH_UNAVAILABLE');
    }finally{working=false;}
  },30000);
  ticker.unref();
  const shutdown=async()=>{
    clearInterval(ticker);
    await new Promise(resolve=>server.close(resolve));
    if(typeof driver.destroy==='function')await driver.destroy().catch(()=>{});
  };
  process.once('SIGTERM',()=>{void shutdown().then(()=>process.exit(0));});
  process.once('SIGINT',()=>{void shutdown().then(()=>process.exit(0));});
  return {app,server,services,shutdown};
}
