(function(){
  if(window.MedsiParentPrewarm)return;
  // Educator preview supplies its own short-lived token. Saved parent caches
  // must never replace it or warm a different account in the background.
  if(document.body.classList.contains('parent-preview-mode'))return;

  const RAW_FETCH=window.fetch.bind(window);
  const PARENT_SESSION_KEY='medsi_parent_auth_session_v1',PHONE_KEY='medsi_parent_phone',LEGACY_PHONE_KEY='medsi_phone',D1_KEY='medsi_d1_parent_session_v1',BOOTSTRAP_CHECK_KEY='medsi_parent_bootstrap_check_v1';
  const p10=v=>String(v||'').replace(/\D+/g,'').slice(-10);
  let d1RecoveryPending=null;

  function extractSession(res){if(!res)return null;if(res.token)return res;if(res.session&&res.session.token)return res.session;if(res.d1Session&&res.d1Session.token)return res.d1Session;return null}
  function parentAuth(){try{return String(localStorage.getItem(PARENT_SESSION_KEY)||'')}catch(_){return''}}
  function parentPhone(){try{return p10(localStorage.getItem(PHONE_KEY)||localStorage.getItem(LEGACY_PHONE_KEY)||'')}catch(_){return''}}
  function storedD1Session(phone){
    try{
      const ph=p10(phone),stored=JSON.parse(localStorage.getItem(D1_KEY)||'null'),session=extractSession(stored),storedPhone=p10(stored&&stored.phone||ph);
      if(!ph||storedPhone!==ph||!session||!session.token)return null;
      if(Number(session.expiresAt||0)&&Number(session.expiresAt)<=Date.now()+3000)return null;
      return session;
    }catch(_){return null}
  }
  function saveStoredD1Session(phone,session){
    if(!session||!session.token)return null;
    try{
      localStorage.setItem(D1_KEY,JSON.stringify({phone:p10(phone),session}));
      localStorage.removeItem(BOOTSTRAP_CHECK_KEY);
    }catch(_){}
    return session;
  }
  function isLabRequest(input){
    try{
      const raw=typeof input==='string'?input:(input&&input.url)||'';
      const url=new URL(raw,window.location.href);
      return url.origin===window.location.origin&&(url.pathname==='/lab'||url.pathname.startsWith('/lab/'));
    }catch(_){return false}
  }
  function withSessionHeader(input,init,session){
    const headers=new Headers((init&&init.headers)||(input&&typeof input!=='string'&&input.headers)||undefined);
    if(session&&session.token)headers.set('X-Medsi-Chat-Session',session.token);
    return Object.assign({},init||{},{headers});
  }
  async function recoverD1Session(phone){
    const ph=p10(phone||parentPhone()),auth=parentAuth();
    if(!ph||!auth)return null;
    if(d1RecoveryPending&&d1RecoveryPending.phone===ph)return d1RecoveryPending.promise;
    const promise=RAW_FETCH('/__session/api',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({action:'api',method:'getD1ChatSession',args:['parent',ph,auth]}),
      cache:'no-store'
    }).then(async response=>{
      if(!response.ok)return null;
      let payload=null;try{payload=await response.json()}catch(_){return null}
      if(!payload||payload.ok!==true)return null;
      const session=extractSession(payload.result);
      if(!session||!session.token)return null;
      saveStoredD1Session(ph,session);
      try{cache.clear();clearSession(ph);savedWarmKey='';}catch(_){}
      return session;
    }).catch(()=>null).finally(()=>{if(d1RecoveryPending&&d1RecoveryPending.promise===promise)d1RecoveryPending=null});
    d1RecoveryPending={phone:ph,promise};
    return promise;
  }

  if(!window.__medsiTimewebSessionFetchWrapped){
    window.__medsiTimewebSessionFetchWrapped=true;
    window.fetch=async function(input,init){
      // Only same-origin lab requests receive a refreshed signed session.
      // Old Google Node.js fetch interception is retired.
      // Block stale frontend modules from contacting the retired service.
      try{
        const raw=typeof input==='string'?input:String(input?.url||'');
        const url=new URL(raw,window.location?.href||'https://medsi.invalid/');
        if(/^(?:script\.google(?:usercontent)?\.com|drive\.google\.com)$/.test(url.hostname)||
           /(?:^|\.)workers\.dev$/.test(url.hostname)){
          return Promise.reject(new Error('LEGACY_UPSTREAM_DISABLED'));
        }
      }catch(_){}
      if(!isLabRequest(input))return RAW_FETCH(input,init);

      const ph=parentPhone();
      let session=storedD1Session(ph);
      let requestInit=session?withSessionHeader(input,init,session):init;
      let response=await RAW_FETCH(input,requestInit);
      if(response.status!==401&&response.status!==410)return response;

      const fresh=await recoverD1Session(ph);
      if(!fresh||!fresh.token)return response;
      session=fresh;
      requestInit=withSessionHeader(input,init,session);
      return RAW_FETCH(input,requestInit);
    };
  }

  const t=window.MedsiOverlayTransport;if(!t)return;
  const cache=new Map(),pending=new Map();
  const originalThread=t.thread.bind(t),originalSend=t.sendMessage.bind(t),originalMarkRead=t.markRead.bind(t),originalMarkUnread=t.markUnread.bind(t),originalPin=t.pin.bind(t),originalUpload=t.upload.bind(t),originalEdit=t.edit.bind(t),originalRemove=t.remove.bind(t),originalReact=t.react.bind(t);
  function key(phone){return p10(phone)}
  function storageKey(phone){return 'medsi_parent_thread_session_v1_'+key(phone)}
  function fresh(entry){return entry&&Date.now()-entry.at<45000}
  function readSession(phone){try{const x=JSON.parse(sessionStorage.getItem(storageKey(phone))||'null');return x&&x.res&&Array.isArray(x.res.messages)?x:null}catch(_){return null}}
  function writeSession(phone,res){try{sessionStorage.setItem(storageKey(phone),JSON.stringify({res,at:Date.now()}))}catch(_){}}
  function clearSession(phone){try{if(phone)sessionStorage.removeItem(storageKey(phone));else Object.keys(sessionStorage).filter(k=>k.startsWith('medsi_parent_thread_session_v1_')).forEach(k=>sessionStorage.removeItem(k))}catch(_){}}
  function rememberThread(phone,res){const entry={res,at:Date.now()};cache.set(key(phone),entry);writeSession(phone,res);return res}
  function cachedThread(phone){const entry=cache.get(key(phone))||readSession(phone);return entry&&entry.res&&Array.isArray(entry.res.messages)?entry.res:null}
  async function confirmParentExists(phone){
    const auth=parentAuth(),ph=p10(phone);if(!auth||!ph)return null;
    try{
      const response=await fetch('/__session/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'api',method:'getParentBootstrap',args:[ph,auth]}),cache:'no-store'});
      const payload=await response.json();
      if(!response.ok||!payload||payload.ok!==true)return null;
      const result=payload.result;
      if(result&&result.ok===false&&result.code==='NOT_FOUND')return false;
      if(result&&result.ok&&result.parentSession)return true;
    }catch(_){}
    return null;
  }
  async function readThreadSafely(session,phone,before,limit){
    const ph=p10(phone);
    try{return await originalThread(session,ph,before||'',limit||100)}
    catch(error){
      if(before||Number(error&&error.status)!==410)throw error;
      const exists=await confirmParentExists(ph);
      if(exists===false)throw error;
      const transient=new Error(exists===true?'Восстанавливаем соединение…':'Профиль чата синхронизируется.');
      transient.code='PROFILE_SYNC_PENDING';transient.status=503;throw transient;
    }
  }
  async function fetchThread(session,phone,before,limit){
    const k=key(phone),pendingKey=(before?'history:':'latest:')+k;
    if(pending.has(pendingKey))return pending.get(pendingKey);
    const p=readThreadSafely(session,k,before,limit).then(res=>{if(!before)rememberThread(k,res);return res}).finally(()=>pending.delete(pendingKey));
    pending.set(pendingKey,p);return p;
  }
  t.thread=function(session,phone,before,limit,options){
    const forceFresh=!!(options&&options.fresh);
    if(forceFresh)return fetchThread(session,phone,before,limit);
    const k=key(phone);
    if(!before){
      const c=cache.get(k)||readSession(k);
      if(fresh(c)){cache.set(k,c);return Promise.resolve(c.res)}
      const pendingKey='latest:'+k;if(pending.has(pendingKey))return pending.get(pendingKey)
    }
    return fetchThread(session,k,before,limit);
  };
  function invalidatePhone(phone){cache.delete(key(phone));clearSession(phone)}
  t.sendMessage=async function(session,role,phone,message){const ph=p10(phone),r=await originalSend(session,role,ph,message);invalidatePhone(ph);return r};
  t.markRead=function(session,role,phone){return originalMarkRead(session,role,p10(phone))};
  t.markUnread=function(session,phone){return originalMarkUnread(session,p10(phone))};
  t.pin=function(session,phone,bucket){return originalPin(session,p10(phone),bucket)};
  t.upload=async function(session,phone,file){
    const ph=p10(phone),active=storedD1Session(ph)||session;
    try{return await originalUpload(active,ph,file)}
    catch(error){
      if(![401,410].includes(Number(error&&error.status)))throw error;
      const fresh=await recoverD1Session(ph);
      if(!fresh||!fresh.token)throw error;
      return originalUpload(fresh,ph,file);
    }
  };
  t.edit=async function(session,role,messageKey,text){const r=await originalEdit(session,role,messageKey,text);cache.clear();clearSession();return r};
  t.remove=async function(session,role,messageKey){const r=await originalRemove(session,role,messageKey);cache.clear();clearSession();return r};
  t.react=async function(session,messageKey,reaction){const r=await originalReact(session,messageKey,reaction);cache.clear();clearSession();return r};

  let loginWarm=null;
  function saveLoginSession(phone,session){if(!session||!session.token)return;saveStoredD1Session(phone,session);fetchThread(session,p10(phone),'',100).catch(()=>{})}
  function prewarmLogin(phone){const ph=p10(phone),auth=parentAuth();if(!ph||!auth)return Promise.resolve(null);if(loginWarm&&loginWarm.phone===ph)return loginWarm.promise;const promise=fetch('/__session/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'api',method:'getD1ChatSession',args:['parent',ph,auth]}),cache:'no-store'}).then(r=>r.json()).then(p=>{const s=extractSession(p&&p.result);if(s)saveLoginSession(ph,s);return s}).catch(()=>null);loginWarm={phone:ph,promise};return promise}
  function installLoginWarm(){const run=()=>{const btn=document.getElementById('authBtn'),input=document.getElementById('phoneInputAuth');if(btn&&input&&!btn.dataset.medsiSessionWarm){btn.dataset.medsiSessionWarm='1';btn.addEventListener('click',()=>prewarmLogin(input.value),true);input.addEventListener('keydown',e=>{if(e.key==='Enter')prewarmLogin(input.value)},true)}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});else run()}
  // Do not contact Node.js before the parent authorization flow finishes.
  // A successful bootstrap already carries the chat session used for prewarming.

  let savedWarmKey='',savedWarmAttemptAt=0;
  function savedChat(){
    try{
      const phone=p10(localStorage.getItem(PHONE_KEY)||localStorage.getItem(LEGACY_PHONE_KEY)||'');
      const session=storedD1Session(phone);
      if(!phone||!session||!session.token)return null;
      return{phone,session};
    }catch(_){return null}
  }
  function kickSavedWarm(){
    const saved=savedChat();if(!saved){savedWarmKey='';return}
    const warmKey=saved.phone+'|'+saved.session.token;
    if(savedWarmKey===warmKey)return;
    if(Date.now()-savedWarmAttemptAt<4000)return;
    savedWarmAttemptAt=Date.now();savedWarmKey=warmKey;
    fetchThread(saved.session,saved.phone,'',100).catch(()=>{if(savedWarmKey===warmKey)savedWarmKey=''});
  }
  kickSavedWarm();
  setInterval(kickSavedWarm,1000);
  window.addEventListener('pageshow',kickSavedWarm);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)kickSavedWarm()});

  window.MedsiParentPrewarm={warm:(session,phone)=>fetchThread(session,p10(phone),'',100).catch(()=>null),ready:phone=>pending.get('latest:'+key(phone))||Promise.resolve((cache.get(key(phone))||readSession(phone))?.res||null),peek:phone=>((cache.get(key(phone))||readSession(phone))?.res||null),clear:()=>{cache.clear();clearSession();savedWarmKey=''},prewarmLogin,kick:kickSavedWarm};
})();
