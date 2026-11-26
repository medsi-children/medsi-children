import express from 'express';
import {createHmac, timingSafeEqual} from 'node:crypto';
import {createDoctorsRoster} from './doctors-roster.mjs';

const COOKIE = 'medsi_doctor';
const SESSION_SECONDS = 30*86400;
const fail = (res,status,message) => res.status(status).json({ok:false,message});
function equal(a,b) {
  const first=Buffer.from(String(a)), second=Buffer.from(String(b));
  return first.length===second.length && timingSafeEqual(first,second);
}

export function createDoctorsRouter(services, env) {
  const router=express.Router();
  const login=env.DOCTORS_LOGIN || env.NEXT_TUTOR_LOGIN;
  const password=env.DOCTORS_PASSWORD || env.NEXT_TUTOR_PASSWORD;
  const sign=expiry=>createHmac('sha256',env.NEXT_SESSION_SECRET)
    .update(JSON.stringify(['doctor',login,password,expiry])).digest('base64url');
  const roster=services.doctorsRoster || createDoctorsRoster(services.sql,env);
  const run=fn=>async(req,res)=>{
    try {return res.json(await fn(req,res));}
    catch {return fail(res,503,'Сервис временно недоступен.');}
  };
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(express.json({limit:'1mb'}));
  // Same-origin JSON only for state-changing routes, including session creation.
  router.use((req,res,next)=>{
    if(req.method==='POST' && (!req.is('application/json') || req.get('sec-fetch-site')==='cross-site'))
      return fail(res,403,'Запрос недоступен.');
    next();
  });
  const attempts=new Map();
  router.post('/login',(req,res)=>{
    const now=Date.now();
    for(const [key,item] of attempts)if(item.expiry<=now)attempts.delete(key);
    const key=req.ip;
    if (!attempts.has(key) && attempts.size>=5000) return fail(res,429,'Повторите вход через минуту.');
    const attempt=attempts.get(key)||{count:0,expiry:now+60000};
    attempts.set(key,attempt);
    if(++attempt.count>15)return fail(res,429,'Повторите вход через минуту.');
    if (!equal(req.body?.login,login) || !equal(req.body?.password,password))
      return fail(res,401,'Неверный логин или пароль.');
    attempts.delete(key);
    const expiry=String(now+SESSION_SECONDS*1000);
    res.cookie(COOKIE,expiry+'.'+sign(expiry),{path:'/doctors/api',httpOnly:true,
      secure:env.DOCTORS_LOCAL_HTTP!=='1',sameSite:'strict',maxAge:SESSION_SECONDS*1000});
    return res.json({ok:true});
  });

  router.use((req,res,next)=>{
    const token=req.get('cookie')?.split(/;\s*/u).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    const [expiry,signature,extra]=String(token || '').split('.');
    if (extra!==undefined || !/^\d{13}$/.test(expiry) || Number(expiry)<=Date.now() || !equal(signature,sign(expiry)))
      return fail(res,401,'Войдите в панель врачей.');
    next();
  });

  router.get('/session',run(()=>({ok:true})));
  router.get('/diagnostics',run(()=>({ok:true,sync:services.doctorsPlans?.diagnostics()||null})));
  router.get('/patients',run(async(req)=>({ok:true,
    patients:await roster.list({refresh:req.query.refresh==='1'})
  })));
  router.get('/phones',run(async()=>({ok:true,patients:(await roster.listBot()).map(({childId,...patient})=>patient)})));
  router.get('/reports',run(()=>services.dashboard.readForEducator()));
  router.get('/parent-directory',run(()=>services.parentDirectory.list()));
  router.post('/discharge',async(req,res)=>{
    if(!services.doctorsPlans)return fail(res,503,'Сохранение дат временно недоступно.');
    try{
      const {patientId,date,revision,confirmConflict}=req.body||{};
      const result=await services.doctorsPlans.enqueue(patientId,date,revision,confirmConflict===true);
      if(!result.ok)return fail(res,result.status,result.message);
      return res.json(result);
    }catch{return fail(res,503,'Не удалось подтвердить сохранение даты.');}
  });
  router.post('/psychology',run(async req=>{
    const {text,submissionId}=req.body || {};
    await services.reports.submit({kind:'psychology',rawText:text,submissionId,authorId:'doctor'});
    return {ok:true,accepted:true,submissionId};
  }));
  return router;
}
