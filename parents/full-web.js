(function(){
  if(window.MedsiParentApp)return;
  window.MedsiParentApp={};
  const APP_BASE_URL='/__session/api';
  const BACKEND_ORIGIN=(window.location&&window.location.origin)||'';
  const PUSH_APP_URL='';
  const PUSH_SERVICE_URL=((window.location&&window.location.origin)||'')+'/push';
  const PHONE_KEY='medsi_parent_phone',LEGACY_PHONE_KEY='medsi_phone',PARENT_KEY='medsi_parent',CHILD_KEY='medsi_child',PARENT_SESSION_KEY='medsi_parent_auth_session_v1',D1_KEY='medsi_d1_parent_session_v1',BOOTSTRAP_CHECK_KEY='medsi_parent_bootstrap_check_v1',REG_ATTEMPT_KEY='medsi_parent_registration_attempt_v1',REAUTH_KEY='medsi_parent_reauthorization_v1';
  const $=id=>document.getElementById(id);
  const reportCache={},reportPending={},reportReadPending={};
  const REPORT_FRESH_MS=60000;let sessionPending=null,menuPending=null,openingChat=false,reportRun=0,historyRun=0,previewMode=false;
  function freshReport(kind){return reportCache[kind]&&Date.now()-Number(reportCache[kind].fetchedAt||0)<REPORT_FRESH_MS}let currentPhone='',parentName='',childName='',regParentName='',regChildName='',justRegistered=false,d1Session=null,pushReady=false,parentSession='',flowRun=0,currentReportKind='morning',currentReportText='',chatReadPending=null,reportHistoryByDate={},reportHistoryMonth=0,reportHistoryMinMonth=0,reportHistoryMaxMonth=0,selectedHistoryDate='';
  const onlyDigits=v=>String(v||'').replace(/\D+/g,'');const validPhone=v=>onlyDigits(v).length>=10;
  const safeGet=k=>{try{return localStorage.getItem(k)||''}catch(_){return''}};
  const safeSet=(k,v)=>{if(previewMode)return;try{localStorage.setItem(k,v)}catch(_){}};const safeRemove=k=>{if(previewMode)return;try{localStorage.removeItem(k)}catch(_){}};
  function timeout(ms){return new Promise((_,reject)=>setTimeout(()=>reject(new Error('TIMEOUT')),ms))}
  async function callApi(method,args,ms,keepalive){
    const readOnly=/^(get|list|verify|check)/i.test(String(method||''));
    const attempts=1; // The gateway owns retries; let its two 15s attempts finish.
    let lastError;
    for(let attempt=0;attempt<attempts;attempt++){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),method==='registerParent'?60000:readOnly?35000:(ms||15000));
      try{
        const r=await fetch(APP_BASE_URL,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify({action:'api',method,args:args||[]}),cache:'no-store',keepalive:!!keepalive,signal:controller.signal});
        const raw=await r.text();let p;try{p=JSON.parse(raw)}catch(_){throw new Error('Сервер вернул некорректный ответ.')}
        if(!r.ok||!p||p.ok!==true)throw new Error((p&&p.message)||('HTTP '+r.status));
        clearTimeout(timer);return p.result;
      }catch(e){
        clearTimeout(timer);lastError=e;
        if(attempt+1<attempts)await wait(350);
      }
    }
    throw lastError||new Error('TIMEOUT');
  }
  async function callBackend(path,method,payload){
    let lastError;
    for(const base of ['',BACKEND_ORIGIN]){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),base?12000:10000);
      try{
        const response=await fetch(base+path,{method,headers:method==='GET'?{}:{'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(payload||{}),cache:'no-store',signal:controller.signal});
        let value;try{value=await response.json()}catch(_){throw new Error('Сервер вернул некорректный ответ.')}
        if(response.ok&&value&&value.ok===true)return value;
        if(response.status===404&&value&&value.code==='NOT_FOUND')return value;
        const error=new Error(value&&value.message||('HTTP '+response.status));
        error.status=response.status;error.code=value&&value.code;
        if(response.status<500||base)throw error;
        lastError=error;
      }catch(error){
        lastError=error;
        if(base||(error&&error.status<500))throw error;
      }finally{clearTimeout(timer)}
    }
    throw lastError||new Error('Сервер временно недоступен.');
  }
  function b64urlToBytes(value){const raw=atob(String(value||'').replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-String(value||'').length%4)%4));return Uint8Array.from(raw,c=>c.charCodeAt(0))}
  function bytesToB64url(value){const bytes=new Uint8Array(value);let raw='';for(let i=0;i<bytes.length;i++)raw+=String.fromCharCode(bytes[i]);return btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')}
  function webauthnOptions(options,registration){const value={...options,challenge:b64urlToBytes(options.challenge)};if(registration&&value.user)value.user={...value.user,id:b64urlToBytes(value.user.id)};if(value.allowCredentials)value.allowCredentials=value.allowCredentials.map(item=>({...item,id:b64urlToBytes(item.id)}));if(value.excludeCredentials)value.excludeCredentials=value.excludeCredentials.map(item=>({...item,id:b64urlToBytes(item.id)}));return value}
  function webauthnCredentialJSON(credential,registration){const response=credential.response,result={id:credential.id,rawId:bytesToB64url(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment||null,response:{clientDataJSON:bytesToB64url(response.clientDataJSON)}};if(registration){result.response.attestationObject=bytesToB64url(response.attestationObject);result.response.transports=typeof response.getTransports==='function'?response.getTransports():[]}else{result.response.authenticatorData=bytesToB64url(response.authenticatorData);result.response.signature=bytesToB64url(response.signature);result.response.userHandle=response.userHandle?bytesToB64url(response.userHandle):null}return result}
  async function callParentPasskey(path,payload){const response=await fetch(BACKEND_ORIGIN+path,{method:'POST',headers:{'content-type':'application/json','x-medsi-chat-session':parentSession},body:JSON.stringify(payload||{}),cache:'no-store'});let result;try{result=await response.json()}catch(_){throw new Error('Сервер вернул некорректный ответ.')}if(!response.ok||!result||result.ok!==true){const error=new Error(result&&result.message||'Не удалось выполнить вход.');error.status=response.status;error.code=result&&result.code;throw error}return result}
  function parentSessionClaims(){try{const payload=String(parentSession||'').split('.')[0],encoded=payload.replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(atob(encoded+'='.repeat((4-encoded.length%4)%4)))}catch(_){return null}}
  function parentSessionNeedsRenewal(){const claims=parentSessionClaims();return !claims||claims.version!=='cf-parent-v2'||Number(claims.exp||0)-Date.now()<30*24*60*60*1000}
  async function renewSavedParentSession(){if(!parentSessionNeedsRenewal())return;const previous=parentSession;try{const result=await Promise.race([callParentPasskey('/lab/parent-session/renew',{}),wait(2500).then(()=>null)]);if(result&&currentPhone&&parentSession===previous&&result.parentSession){parentSession=String(result.parentSession);safeSet(PARENT_SESSION_KEY,parentSession)}}catch(_){/* Keep the saved session; recovery remains available if renewal is unavailable. */}}
  let preparedPasskeyLogin=null;
  async function preparePasskeyLogin(){const button=$('passkeyLoginBtn');if(!button||!window.PublicKeyCredential||!navigator.credentials){button.disabled=true;button.textContent='Ключ доступа не поддерживается';return}button.disabled=true;button.textContent='Подготавливаем вход…';try{preparedPasskeyLogin=await callBackend('/lab/parent-passkeys/authentication/options','POST',{});if(document.body.dataset.screen==='screenAuth'){button.disabled=false;button.textContent='Войти с ключом доступа'}}catch(error){preparedPasskeyLogin=null;if(document.body.dataset.screen==='screenAuth'){button.disabled=false;button.textContent='Попробовать снова';$('passkeyLoginError').textContent='Не удалось подготовить вход. Проверьте связь и попробуйте ещё раз.';$('passkeyLoginError').classList.remove('hidden')}}}
  async function loginWithPasskey(){const button=$('passkeyLoginBtn'),error=$('passkeyLoginError');error.classList.add('hidden');if(!preparedPasskeyLogin){await preparePasskeyLogin();return}const ready=preparedPasskeyLogin;preparedPasskeyLogin=null;button.disabled=true;button.textContent='Подтвердите вход…';try{const credential=await navigator.credentials.get({publicKey:webauthnOptions(ready.options,false)});if(!credential)throw new Error('Вход отменён.');const result=await callBackend('/lab/parent-passkeys/authentication/verify','POST',{challengeId:ready.challengeId,credential:webauthnCredentialJSON(credential,false)});if(!applyBootstrap(result))throw new Error('Не удалось сохранить вход.');safeRemove(REAUTH_KEY);prewarmAll();justRegistered=false;showChoose()}catch(e){if(e&&e.name==='NotAllowedError'){error.textContent='Ключ не найден или вход отменён. Попробуйте ещё раз на устройстве, где он сохранён.'}else error.textContent=String(e&&e.message||'Не удалось выполнить вход.');error.classList.remove('hidden');button.disabled=false;button.textContent='Войти с ключом доступа';preparePasskeyLogin()}}
  async function askToSavePasskey(){
    const dialog=$('passkeyOfferDialog'),later=$('passkeyLaterBtn'),save=$('passkeySaveBtn'),error=$('passkeyOfferError');
    if(!dialog||dialog.open)return;
    error.classList.add('hidden');save.classList.remove('hidden');save.disabled=false;save.textContent='Включить';later.textContent='Не сейчас';
    if(!window.isSecureContext||!navigator.credentials||!window.PublicKeyCredential){
      error.textContent='Этот браузер не поддерживает защищённый вход. Вы можете продолжить без него.';
      error.classList.remove('hidden');save.classList.add('hidden');later.textContent='Продолжить';dialog.showModal();
      await new Promise(resolve=>{later.onclick=()=>{dialog.close();resolve()}});
      return;
    }
    let prepared=null,alreadyHasPasskey=false;
    const prepare=async()=>{
      const status=await callParentPasskey('/lab/parent-passkeys/status',{});
      if(status.hasPasskey){alreadyHasPasskey=true;return}
      prepared=await callParentPasskey('/lab/parent-passkeys/registration/options',{});
    };
    try{await prepare()}catch(_){error.textContent='Не удалось проверить защищённый вход. Можно продолжить или попробовать ещё раз.';error.classList.remove('hidden')}
    if(alreadyHasPasskey)return;
    dialog.showModal();
    await new Promise(resolve=>{
      later.onclick=()=>{dialog.close();resolve()};
      save.onclick=async()=>{
        if(!prepared){
          save.disabled=true;save.textContent='Проверяем…';error.classList.add('hidden');
          try{await prepare();if(alreadyHasPasskey){dialog.close();resolve();return}error.textContent='Готово. Нажмите «Включить» ещё раз, чтобы сохранить ключ.'}
          catch(_){error.textContent='Проверка не прошла. Проверьте связь и нажмите «Повторить».'}
          error.classList.remove('hidden');save.disabled=false;save.textContent='Повторить';return;
        }
        save.disabled=true;save.textContent='Создаём ключ…';error.classList.add('hidden');
        try{
          const credential=await navigator.credentials.create({publicKey:webauthnOptions(prepared.options,true)});
          if(!credential)throw new Error('Не удалось создать ключ доступа.');
          await callParentPasskey('/lab/parent-passkeys/registration/verify',{challengeId:prepared.challengeId,credential:webauthnCredentialJSON(credential,true)});
          dialog.close();resolve();
        }catch(e){prepared=null;error.textContent=e&&e.name==='NotAllowedError'?'Не удалось сохранить ключ. Можно продолжить без него.':'Не удалось сохранить ключ. Проверьте связь и попробуйте ещё раз.';error.classList.remove('hidden');save.disabled=false;save.textContent='Повторить'}
      };
    });
  }
  function callBackendRegistration(status,data){
    const path=status?'/lab/parent-registration/status?phone='+encodeURIComponent(data.phone)+'&attemptId='+encodeURIComponent(data.attemptId):'/lab/parent-registration';
    return callBackend(path,status?'GET':'POST',status?null:{parentName:data.parentName,childName:data.childName,phone:data.phone,attemptId:data.attemptId});
  }
  function callBackendAccess(status,data){
    const path=status?'/lab/parent-auth/status':'/lab/parent-auth/request';
    return callBackend(path,'POST',{phone:data.phone,requestId:data.requestId,requestSecret:data.requestSecret});
  }
  function isStartLike(id){return id==='screenStart'||id==='screenChoose'}
  function initPush(){if(previewMode||pushReady||!window.MedsiPush)return;pushReady=true;const ph=onlyDigits(safeGet(PHONE_KEY)||safeGet(LEGACY_PHONE_KEY));MedsiPush.init({frameId:'__no_parent_iframe__',appEndpointUrl:PUSH_APP_URL,pushServiceUrl:PUSH_SERVICE_URL,identity:validPhone(ph)?{role:'parent',phone:ph}:null})}
  function syncPushIdentity(){if(previewMode||!window.MedsiPush)return;if(validPhone(currentPhone))MedsiPush.setIdentity({role:'parent',phone:currentPhone,parentSession:parentSession||''});else MedsiPush.clearIdentity()}
  function show(id){['screenStart','screenNames','screenPhoneReg','screenAuth','screenRegistrationPending','screenAuthPending','screenChoose','screenReport','screenReportHistory','screenSchedule','screenChat'].forEach(x=>$(x).classList.toggle('hidden',x!==id));document.body.dataset.screen=id;$('appCard').classList.toggle('start-mode',id==='screenStart');$('headerBlock').classList.toggle('hidden',isStartLike(id)||id==='screenChat'||id==='screenRegistrationPending'||id==='screenAuthPending');const el=$(id);el.classList.remove('screen-enter');void el.offsetWidth;el.classList.add('screen-enter');setTimeout(()=>el.classList.remove('screen-enter'),300);setChips();if(window.MedsiPush)MedsiPush.setPanelVisible(!previewMode&&(id==='screenChoose'||id==='screenChat'));window.scrollTo(0,0)}
  function setHeader(title,meta){$('title').textContent=title;$('meta').textContent=meta||''}
  function setChips(){const screen=document.body.dataset.screen||'',registrationPending=screen==='screenRegistrationPending',authPending=screen==='screenAuthPending',pendingVisible=registrationPending||authPending,authed=!!currentPhone&&!!parentSession&&!['screenStart','screenNames','screenPhoneReg','screenAuth','screenRegistrationPending','screenAuthPending'].some(id=>!$(id).classList.contains('hidden'));let displayChild=childName||'',displayPhone=currentPhone?('8'+onlyDigits(currentPhone).slice(-10)):'';if(registrationPending){const pending=readJson(REG_ATTEMPT_KEY)||{};displayChild=String(pending.childName||regChildName||'').trim();displayPhone=pending.phone?('8'+onlyDigits(pending.phone).slice(-10)):''}else if(authPending){const pending=readJson(REAUTH_KEY)||{};displayChild='';displayPhone=pending.phone?('8'+onlyDigits(pending.phone).slice(-10)):''}const chips=$('chips'),visible=authed||pendingVisible;chips.classList.toggle('hidden',!visible);chips.style.display=visible?'flex':'none';$('childChip').textContent=displayChild;$('childChip').classList.toggle('hidden',!displayChild);$('phoneChip').textContent=displayPhone;$('phoneChip').classList.toggle('hidden',!displayPhone);const logout=$('logoutBtn');if(logout){logout.textContent='Выйти';logout.classList.remove('hidden')}}
  function setBadge(id,visible){const el=$(id);if(!el)return;el.classList.toggle('hidden',!visible);requestAnimationFrame(()=>el.classList.toggle('show',!!visible))}
  function applyUnread(res){const unread=res&&res.reportUnread||{};setBadge('newMsgBanner',!!(res&&res.hasUnread));setBadge('morningReportBadge',!!unread.morning);setBadge('eveningReportBadge',!!unread.evening);setBadge('psychologyReportBadge',!!unread.psychology)}
  function markChatBadgeRead(){if(previewMode)return Promise.resolve(null);setBadge('newMsgBanner',false);if(!currentPhone||!parentSession)return Promise.resolve(null);const phone=currentPhone,session=parentSession;const pending=callApi('markEducatorMessagesAsRead',[phone,session],12000,true).catch(()=>null).finally(()=>{if(chatReadPending===pending)chatReadPending=null});chatReadPending=pending;return pending}
  function markReportBadgeRead(kind,res){if(previewMode)return Promise.resolve(null);hideReportBadge(kind);if(!currentPhone||!parentSession||!res||!res.hasReport||!res.version)return Promise.resolve(null);if(reportReadPending[kind])return reportReadPending[kind];const phone=currentPhone,session=parentSession,version=String(res.version);const pending=callApi('markReportAsRead',[phone,kind,version,session],12000,true).catch(()=>null).finally(()=>{if(reportReadPending[kind]===pending)delete reportReadPending[kind]});reportReadPending[kind]=pending;return pending}
  function showStart(){setHeader('Медси Бот','Облачная система для просмотра отчётов по вашему ребёнку и для связи с воспитателями.');show('screenStart')}
  function showNames(){setHeader('Регистрация родителя','Укажите данные ребёнка и родителя.');show('screenNames')}
  function showPhoneReg(){setHeader('Телефон для входа','Введите номер, с которым будете входить в систему.');show('screenPhoneReg')}
  function showAuth(){setHeader('Авторизация','Подтвердите вход системным ключом доступа.');$('phoneAuthFallback').classList.add('hidden');$('passkeyLoginError').classList.add('hidden');show('screenAuth');preparePasskeyLogin()}
  function applyBootstrap(res){if(!res||!res.ok||!res.parentSession)return false;currentPhone=onlyDigits(res.phone||currentPhone);parentName=String(res.parentName||parentName||'').trim();childName=String(res.childName||childName||'').trim();parentSession=String(res.parentSession);if(res.d1Session&&res.d1Session.token)saveD1Session(res.d1Session);safeSet(PARENT_SESSION_KEY,parentSession);safeSet(PHONE_KEY,currentPhone);safeSet(LEGACY_PHONE_KEY,currentPhone);safeSet(PARENT_KEY,parentName);safeSet(CHILD_KEY,childName);applyUnread(res);syncPushIdentity();return true}
  function showChoose(){if(window.MedsiParentChatScreen)MedsiParentChatScreen.close();setHeader('Медси Бот','Облачная система для просмотра отчётов по вашему ребёнку и для связи с воспитателями.');$('waitNote').classList.toggle('hidden',!justRegistered);prewarmAll();show('screenChoose');openRequestedDestination()}
  function openRequestedDestination(){const url=new URL(location.href),destination=url.searchParams.has('openMorning')?'morning':url.searchParams.has('openChat')?'chat':url.searchParams.has('openTherapy')?'therapy':'';if(!destination)return;url.searchParams.delete('openMorning');url.searchParams.delete('openChat');url.searchParams.delete('openTherapy');history.replaceState(history.state,'',url.pathname+url.search+url.hash);Promise.resolve().then(()=>{if(document.body.dataset.screen!=='screenChoose')return;if(destination==='chat')openChat();else openReport(destination==='morning'?'morning':'psychology')})}
  function clearSession(){sessionPending=null;menuPending=null;reportRun++;historyRun++;currentPhone='';parentName='';childName='';parentSession='';d1Session=null;chatReadPending=null;flowRun++;safeRemove(PHONE_KEY);safeRemove(LEGACY_PHONE_KEY);safeRemove(PARENT_KEY);safeRemove(CHILD_KEY);safeRemove(PARENT_SESSION_KEY);safeRemove(D1_KEY);safeRemove(BOOTSTRAP_CHECK_KEY);Object.keys(reportCache).forEach(k=>delete reportCache[k]);Object.keys(reportPending).forEach(k=>delete reportPending[k]);Object.keys(reportReadPending).forEach(k=>delete reportReadPending[k]);if(window.MedsiParentPrewarm)MedsiParentPrewarm.clear();if(window.MedsiParentChatScreen)MedsiParentChatScreen.close();syncPushIdentity()}
  async function restoreSaved(){
    const ph=onlyDigits(safeGet(PHONE_KEY)||safeGet(LEGACY_PHONE_KEY));
    if(!validPhone(ph)){showStart();return}
    currentPhone=ph;
    parentName=String(safeGet(PARENT_KEY)||'').trim();
    childName=String(safeGet(CHILD_KEY)||'').trim();
    parentSession=safeGet(PARENT_SESSION_KEY);if(!parentSession){clearSession();$('phoneInputAuth').value=ph;showAuth();return}syncPushIdentity();
    const restoreRun=flowRun;
    renewSavedParentSession();
    await Promise.resolve(window.MedsiAssistantReady);
    if(currentPhone!==ph||flowRun!==restoreRun)return;
    showChoose();
    try{if(await refreshProfileFromD1()){prewarmAll();refreshChatUnreadFromD1();return}}catch(_){/* fall back to the authoritative Apps Script check below */}
    const lastBootstrap=Number(safeGet(BOOTSTRAP_CHECK_KEY)||0);
    if(lastBootstrap&&Date.now()-lastBootstrap<15*60*1000){prewarmAll();return}
    try{
      const res=await callApi('getParentBootstrap',[ph,parentSession],12000);
      if(currentPhone!==ph||flowRun!==restoreRun)return;
      if(!applyBootstrap(res)){if(res&&res.code==='NOT_FOUND'){clearSession();$('phoneInputAuth').value=ph;showAuth();}return}
      safeSet(BOOTSTRAP_CHECK_KEY,String(Date.now()));
      setChips();
      prewarmAll();
    }catch(_){
      // A temporary network failure must not kick an already saved parent out.
      // The visible menu stays available and background prewarm can recover later.
    }
  }
  function isSingleWord(v){return !/\s/.test(String(v||'').trim())}
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function readJson(key){try{return JSON.parse(safeGet(key)||'null')}catch(_){return null}}
  function makeFlowId(prefix){let value='';try{if(crypto&&crypto.randomUUID)value=crypto.randomUUID()}catch(_){}if(!value)value=Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);return prefix+'_'+value.replace(/[^A-Za-z0-9_-]/g,'')}
  function makeAccessSecret(){return bytesToB64url(crypto.getRandomValues(new Uint8Array(32)))}
  function registrationFingerprint(data){return [onlyDigits(data.phone).slice(-10),data.parentName,data.childName].join('|')}
  async function finishRegistration(res,run){if(!applyBootstrap(res))throw new Error('Регистрация завершена, но сессия не получена. Продолжаем проверку.');safeRemove(REG_ATTEMPT_KEY);justRegistered=true;prewarmAll();const attemptId=String(res.registrationAttemptId||'');if(attemptId)callApi('mirrorCloudflareParentRegistration',[currentPhone,attemptId,parentSession],5000,true).catch(()=>null);await Promise.resolve(window.MedsiAssistantReady);if(run===flowRun){showChoose();askToSavePasskey()}}
  function registrationCanRetry(message,data,run){
    if(run!==flowRun)return;
    $('registrationPendingText').textContent=message;
    $('registrationPendingSpinner').classList.add('hidden');
    const actions=$('registrationPendingActions');actions.classList.remove('hidden');
    $('registrationRetryBtn').onclick=()=>{if(run!==flowRun)return;actions.classList.add('hidden');$('registrationPendingSpinner').classList.remove('hidden');runRegistrationFlow(data)};
    $('registrationCancelBtn').onclick=()=>{if(run!==flowRun)return;flowRun++;showStart()};
  }
  async function runRegistrationFlow(data){
    const run=++flowRun;
    show('screenRegistrationPending');
    $('registrationPendingActions').classList.add('hidden');
    $('registrationPendingSpinner').classList.remove('hidden');
    const pendingText=$('registrationPendingText');
    pendingText.textContent='Пожалуйста, подождите. Мы сохраняем данные и готовим Медси Бот.';
    let phase='register',delay=1000,notFoundCount=0,processingCount=0;
    const deadline=Date.now()+90000;
    while(run===flowRun&&Date.now()<deadline){
      try{
        let res=null;
        if(phase==='register'){
          try{
            res=await callBackendRegistration(false,data);
          }catch(error){
            if(run!==flowRun)return;
            if(error&&error.code==='DELETION_PENDING'){
              registrationCanRetry('Предыдущее удаление профиля ещё завершается. Подождите немного и нажмите «Проверить снова».',data,run);
              return;
            }
            phase='status';
            pendingText.textContent='Регистрация занимает больше времени, чем обычно. Проверяем результат…';
          }
          if(run!==flowRun)return;
          if(res){
            if(res.duplicate){safeRemove(REG_ATTEMPT_KEY);$('phoneInputAuth').value=data.phone;showAuth();return}
            if(res.ok&&res.parentSession){await finishRegistration(res,run);return}
            phase='status';
          }
        }
        if(phase==='status'){
          const statusRes=await callBackendRegistration(true,data);
          if(run!==flowRun)return;
          if(statusRes&&statusRes.ok&&statusRes.parentSession){await finishRegistration(statusRes,run);return}
          if(statusRes&&statusRes.result&&statusRes.result.parentSession){await finishRegistration(statusRes.result,run);return}
          const status=String(statusRes&&(statusRes.status||statusRes.code)||'').toUpperCase();
          if(status==='REVOKED'){safeRemove(REG_ATTEMPT_KEY);showStart();return}
          if(status==='PROCESSING'){
            processingCount++;
            if(processingCount>=3){phase='register';processingCount=0;pendingText.textContent='Завершаем сохранение данных…'}
          }else if(status==='NOT_FOUND'){
            notFoundCount++;
            if(notFoundCount>=3){phase='register';notFoundCount=0;pendingText.textContent='Проверяем регистрацию ещё раз…'}
          }else{
            notFoundCount=0;
            pendingText.textContent='Регистрация занимает больше времени, чем обычно. Проверяем результат…';
          }
        }
      }catch(_){
        if(run!==flowRun)return;
        phase='status';
        pendingText.textContent='Регистрация занимает больше времени, чем обычно. Проверяем результат…';
      }
      await wait(delay);
      delay=Math.min(3500,delay+400);
    }
    if(run===flowRun)registrationCanRetry('Не удалось подтвердить регистрацию. Ваши данные сохранены. Нажмите «Проверить снова», чтобы безопасно продолжить ту же попытку.',data,run);
  }
  async function register(){const digits=onlyDigits($('phoneInputReg').value),err=$('phoneErrorReg'),info=$('alreadyRegistered');err.classList.add('hidden');info.classList.add('hidden');if(!validPhone(digits)){err.textContent='Введите номер — минимум 10 цифр.';err.classList.remove('hidden');return}const snapshot={phone:digits,parentName:regParentName,childName:regChildName};const saved=readJson(REG_ATTEMPT_KEY);snapshot.attemptId=saved&&saved.fingerprint===registrationFingerprint(snapshot)?saved.attemptId:makeFlowId('reg');snapshot.fingerprint=registrationFingerprint(snapshot);safeSet(REG_ATTEMPT_KEY,JSON.stringify(snapshot));runRegistrationFlow(snapshot)}
  function resetAuthPendingUi(){const screen=$('screenAuthPending');screen.classList.remove('is-approved');$('authPendingSpinner').classList.remove('hidden');$('authApprovedIcon').classList.add('hidden');$('authPendingTitle').textContent='Проверяем доступ';$('authPendingText').textContent='Пожалуйста, подождите…';$('authRequestCode').textContent='••••';$('authRequestCodeWrap').classList.add('hidden');$('authPendingBackBtn').classList.add('hidden')}
  function showAuthApproved(res){if(!applyBootstrap(res))throw new Error('Не удалось сохранить подтверждённый вход.');safeRemove(REAUTH_KEY);prewarmAll();const screen=$('screenAuthPending');screen.classList.add('is-approved');$('authPendingSpinner').classList.add('hidden');$('authApprovedIcon').classList.remove('hidden');$('authRequestCodeWrap').classList.add('hidden');$('authPendingTitle').textContent='Авторизация подтверждена!';$('authPendingText').textContent='Вход сохранён на этом устройстве.';const approvedRun=flowRun;Promise.all([wait(1800),Promise.resolve(window.MedsiAssistantReady)]).then(()=>{if(flowRun===approvedRun&&document.body.dataset.screen==='screenAuthPending'){justRegistered=false;showChoose()}})}
  function showAuthStopped(status,message){$('authPendingSpinner').classList.add('hidden');$('authRequestCodeWrap').classList.add('hidden');$('authPendingTitle').textContent=status==='DENIED'?'Авторизация отклонена':status==='NOT_FOUND'?'Номер не найден':status==='CONSUMED'?'Запрос уже использован':'Срок запроса истёк';$('authPendingText').textContent=message||'Вы можете отправить новый запрос.';$('authPendingBackBtn').classList.remove('hidden')}
  async function runReauthorizationFlow(data,createFirst){
    const run=++flowRun;resetAuthPendingUi();let shouldCreate=!!createFirst,pollDelay=2000;
    const authButton=$('authBtn'),originalButtonText=authButton.textContent;
    let pendingVisible=!shouldCreate;
    if(pendingVisible)show('screenAuthPending');
    else if(document.body.dataset.screen==='screenAuth'){authButton.disabled=true;authButton.textContent='Проверяем…'}
    const restoreButton=()=>{authButton.disabled=false;authButton.textContent=originalButtonText};
    while(run===flowRun){
      try{
        let res=await callBackendAccess(!shouldCreate,data);
        if(run!==flowRun)return;
        if(res&&res.code==='NOT_FOUND'&&res.ok===false){
          restoreButton();safeRemove(REAUTH_KEY);$('phoneInputAuth').value=data.phone;showAuth();$('phoneAuthFallback').classList.remove('hidden');
          $('phoneErrorAuth').textContent='Этот номер не найден среди активных родителей.';
          $('phoneErrorAuth').classList.remove('hidden');return;
        }
        if(!res||res.ok===false)throw new Error((res&&res.message)||'Не удалось проверить авторизацию.');
        if(res.status==='NOT_FOUND'){shouldCreate=true;continue}
        if(res.status==='PASSKEY_REQUIRED'){restoreButton();safeRemove(REAUTH_KEY);showAuth();$('phoneErrorAuth').textContent='Для этого аккаунта сохранён ключ доступа. Войдите с его помощью.';$('phoneErrorAuth').classList.remove('hidden');return}
        restoreButton();
        if(!pendingVisible){show('screenAuthPending');pendingVisible=true}
        shouldCreate=false;
        $('authPendingText').textContent='Проверяем возможность входа…';
        if(res.code){$('authRequestCode').textContent=res.code;$('authRequestCodeWrap').classList.remove('hidden')}
        if(res.parentSession){showAuthApproved(res);return}
        if(res.status==='DENIED'){safeRemove(REAUTH_KEY);showAuthStopped('DENIED','Воспитатель отклонил запрос. При необходимости свяжитесь с отделением.');return}
        if(res.status==='CONSUMED'){safeRemove(REAUTH_KEY);showAuthStopped('CONSUMED','Этот запрос уже использован. Начните вход ещё раз.');return}
        if(res.status==='EXPIRED'){safeRemove(REAUTH_KEY);showAuthStopped('EXPIRED','Запрос больше не действует. Отправьте новый запрос на вход.');return}
        if(res.status==='NOT_FOUND')shouldCreate=true;
      }catch(e){if(run!==flowRun)return;if(e&&e.code==='PASSKEY_REQUIRED'){restoreButton();safeRemove(REAUTH_KEY);showAuth();$('phoneErrorAuth').textContent='Для этого аккаунта сохранён ключ доступа. Войдите с его помощью.';$('phoneErrorAuth').classList.remove('hidden');return}restoreButton();if(!pendingVisible){show('screenAuthPending');pendingVisible=true}$('authPendingText').textContent='Связь временно прервана. Продолжаем проверять запрос…'}
      await wait(pollDelay);pollDelay=Math.min(8000,pollDelay+1000);
    }
  }
  async function beginReauthorization(phoneRaw,forceNew){const digits=onlyDigits(phoneRaw);if(!validPhone(digits))return;let saved=readJson(REAUTH_KEY);if(forceNew||!saved||onlyDigits(saved.phone).slice(-10)!==digits.slice(-10)||!saved.requestSecret)saved={phone:digits,requestId:makeFlowId('auth'),requestSecret:makeAccessSecret()};safeSet(REAUTH_KEY,JSON.stringify(saved));runReauthorizationFlow(saved,true)}
  async function auth(){const digits=onlyDigits($('phoneInputAuth').value),err=$('phoneErrorAuth');err.classList.add('hidden');if(!validPhone(digits)){err.textContent='Введите номер — минимум 10 цифр.';err.classList.remove('hidden');return}beginReauthorization(digits,true)}
  function extractSession(res){if(res&&res.token)return res;if(res&&res.session&&res.session.token)return res.session;return null}
  function saveD1Session(session){if(!session||!session.token)return null;d1Session=session;safeSet(D1_KEY,JSON.stringify({phone:onlyDigits(currentPhone).slice(-10),session}));return session}
  function loadCachedD1Session(phone){try{const saved=JSON.parse(safeGet(D1_KEY)||'null'),session=extractSession(saved),savedPhone=onlyDigits(saved&&saved.phone||phone).slice(-10);if(session&&savedPhone===onlyDigits(phone).slice(-10)&&Number(session.expiresAt||0)>Date.now()+30000)return saveD1Session(session)}catch(_){}return null}
  async function refreshProfileFromD1(){const phone=currentPhone,auth=parentSession;let value;try{value=await readD1('/lab/profile')}catch(error){if(error.status!==410)throw error;if(previewMode)return false;
    // A D1 profile can briefly lag behind REPORTS after registration or a
    // background reconcile.  Confirm deletion through the authoritative
    // bootstrap before discarding a perfectly valid saved parent session.
    try{
      const fallback=await callApi('getParentBootstrap',[phone,auth],12000);
      if(currentPhone!==phone||parentSession!==auth)return false;
      if(applyBootstrap(fallback)){safeSet(BOOTSTRAP_CHECK_KEY,String(Date.now()));setChips();return true}
    }catch(_){/* keep the saved session while the backend recovers */}
    return false
  }if(phone!==currentPhone||parentSession!==auth)return false;parentName=String(value.parentName||parentName||'').trim();childName=String(value.childName||childName||'').trim();safeSet(PARENT_KEY,parentName);safeSet(CHILD_KEY,childName);setChips();safeSet(BOOTSTRAP_CHECK_KEY,String(Date.now()));return true}
  async function warmD1(force){
    if(!currentPhone)return null;
    if(previewMode){if(d1Session&&Number(d1Session.expiresAt)>Date.now())return d1Session;throw new Error('Время предварительного просмотра истекло. Откройте панель заново через параметры воспитателя.');}
    if(sessionPending)return sessionPending;
    if(!force){if(d1Session&&Number(d1Session.expiresAt||0)>Date.now()+30000)return d1Session;const cached=loadCachedD1Session(currentPhone);if(cached)return cached;}
    const phone=currentPhone,auth=parentSession;
    const pending=callApi('getD1ChatSession',['parent',phone,auth],35000).then(res=>{
      const session=extractSession(res);
      if(currentPhone!==phone||parentSession!==auth)return null;
      return session?saveD1Session(session):null;
    }).finally(()=>{if(sessionPending===pending)sessionPending=null});
    sessionPending=pending;return pending;
  }
  async function readD1(path){
    const phone=currentPhone,auth=parentSession;
    let session=await warmD1(),lastError;
    for(let attempt=0;attempt<2;attempt++){
      if(!session||currentPhone!==phone||parentSession!==auth)throw new Error('Не удалось получить доступ. Повторяем подключение…');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{
        const response=await fetch(path,{headers:{'X-Medsi-Chat-Session':session.token},cache:'no-store',signal:controller.signal});
        const value=await response.json();
        if(!response.ok||!value||!value.ok){const error=new Error(value&&value.message||'Не удалось загрузить данные.');error.status=response.status;throw error;}
        return value;
      }catch(error){
        lastError=error;
        if(error.status===401&&attempt===0){session=await warmD1(true);}
        else if(error.status&&error.status<500&&![408,425,429].includes(error.status))throw error;
      }finally{clearTimeout(timer);}
      if(attempt===0)await wait(400);
    }
    throw lastError;
  }
  function normalizeCurrentReports(value){const reports={morning:{ok:true,text:'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏',hasReport:false,version:'',updatedAt:0},evening:{ok:true,text:'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏',hasReport:false,version:'',updatedAt:0},psychology:{ok:true,text:'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏',hasReport:false,version:'',updatedAt:0}};(Array.isArray(value&&value.reports)?value.reports:[]).forEach(item=>{const kind=String(item&&item.kind||'').toLowerCase();if(!['morning','evening','psychology'].includes(kind))return;const text=String(item&&item.text||'').trim();reports[kind]={ok:true,text:text||'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏',hasReport:!!text,version:String(item&&item.version||''),updatedAt:Number(item&&item.updatedAt||0)}});return reports}
  async function fetchCurrentReportsFromD1(){return normalizeCurrentReports(await readD1('/lab/report-current'))}
  async function refreshChatUnreadFromD1(){const phone=currentPhone,auth=parentSession;try{const res=await readD1('/lab/parent-unread');if(phone!==currentPhone||auth!==parentSession)return null;setBadge('newMsgBanner',!!(res&&res.hasUnread));return res}catch(_){return null}}
  function warmAllReports(forceKind){
    const kinds=['morning','evening','psychology'];
    if(!currentPhone||(!forceKind&&kinds.every(kind=>freshReport(kind)||reportPending[kind])))return;
    const phone=currentPhone,session=parentSession;
    const batch=fetchCurrentReportsFromD1().then(reports=>{
      if(currentPhone!==phone||parentSession!==session)return {};
      kinds.forEach(kind=>{if(reports[kind])reportCache[kind]={...reports[kind],fetchedAt:Date.now()};});
      return reportCache;
    }).catch(()=>({}));
    kinds.forEach(kind=>{if(reportPending[kind])return;const pending=batch.then(reports=>reports[kind]||null).finally(()=>{if(reportPending[kind]===pending)delete reportPending[kind]});reportPending[kind]=pending;});
  }
  function warmReport(kind,force){if(!force&&freshReport(kind))return Promise.resolve(reportCache[kind]);if(!reportPending[kind])warmAllReports(force?kind:'');return reportPending[kind]||Promise.resolve(null)}
  function prewarmAll(){if(!currentPhone)return;warmAllReports();}
  function refreshParentMenu(){
    if(!currentPhone||!parentSession)return Promise.resolve();
    if(menuPending)return menuPending;
    const phone=currentPhone,auth=parentSession;prewarmAll();
    const bootstrap=refreshProfileFromD1().then(ready=>{if(ready||previewMode||phone!==currentPhone||auth!==parentSession)return;return callApi('getParentBootstrap',[phone,auth],35000).then(res=>{if(phone!==currentPhone||auth!==parentSession)return;if(applyBootstrap(res)){safeSet(BOOTSTRAP_CHECK_KEY,String(Date.now()));setChips();}});}).catch(()=>null);
    const chat=warmD1().then(session=>session&&window.MedsiParentPrewarm?MedsiParentPrewarm.warm(session,currentPhone):null);
    const unread=refreshChatUnreadFromD1();
    const pending=Promise.allSettled([bootstrap,chat,unread]).finally(()=>{if(menuPending===pending)menuPending=null});menuPending=pending;return pending;
  }
  function reportTitle(kind){return kind==='morning'?'Утренний отчёт':kind==='evening'?'Вечерний отчёт':'Групповая терапия'}
  function normalizeBlock(v){return String(v||'').replace(/\s+/g,' ').trim()}
  function dedupeExactReport(text){const raw=String(text||'').trim();if(!raw)return raw;const blocks=raw.split(/\n\s*\n+/).map(x=>x.trim()).filter(Boolean);if(blocks.length>1){const seen=new Set(),unique=[];for(const block of blocks){const key=normalizeBlock(block);if(!key||seen.has(key))continue;seen.add(key);unique.push(block)}if(unique.length<blocks.length)return unique.join('\n\n')}const lines=raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);if(lines.length===2&&normalizeBlock(lines[0])===normalizeBlock(lines[1]))return lines[0];return raw}
  function hideReportBadge(kind){setBadge(kind==='morning'?'morningReportBadge':kind==='evening'?'eveningReportBadge':'psychologyReportBadge',false)}
  function showReportResult(kind,res){if(document.body.dataset.screen!=='screenReport'||currentReportKind!==kind)return false;if(!res||!res.ok){$('reportError').textContent=(res&&res.message)||'Отчёт пока недоступен.';$('reportError').classList.remove('hidden');$('reportContent').textContent='';return false}$('reportError').classList.add('hidden');currentReportText=dedupeExactReport(res.text||'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏');$('reportContent').textContent=currentReportText;$('reportCopyBtn').classList.toggle('hidden',!currentReportText.trim());markReportBadgeRead(kind,res);return true}
  async function copyText(text,button){const value=String(text||'');if(!value.trim())return;let copied=false;try{await navigator.clipboard.writeText(value);copied=true}catch(_){const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();try{copied=document.execCommand('copy')}catch(__){}area.remove()}if(copied&&button){button.classList.add('is-copied');button.setAttribute('aria-label','Скопировано');setTimeout(()=>{button.classList.remove('is-copied');button.setAttribute('aria-label','Скопировать отчёт')},1200)}}
  const historyCopyIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>';
  const historySunIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"></circle><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"></path></svg>';
  const historyMoonIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 15.1A8.2 8.2 0 0 1 8.9 4.6 8.2 8.2 0 1 0 19.4 15.1Z"></path></svg>';
  const historyTherapyIcon='<img src="/chat-overlay/assets/twemoji/1f9e0.svg" alt="" aria-hidden="true">';
  function historyDateParts(value){const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));if(!match)return null;const year=Number(match[1]),month=Number(match[2])-1,day=Number(match[3]);if(month<0||month>11||day<1||day>new Date(year,month+1,0).getDate())return null;return{year,month,day}}
  function historyDateLabel(value){const parts=historyDateParts(value);if(!parts)return String(value||'');return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(parts.year,parts.month,parts.day))}
  function historyMonthLabel(year,month){const label=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(new Date(year,month,1)).replace(/\s*г\.$/,'');return label.charAt(0).toUpperCase()+label.slice(1)}
  function historyDateKey(year,month,day){return year+'-'+String(month+1).padStart(2,'0')+'-'+String(day).padStart(2,'0')}
  function historyKindMeta(kind){if(kind==='morning')return{label:'Утренний отчёт',icon:historySunIcon,order:0};if(kind==='evening')return{label:'Вечерний отчёт',icon:historyMoonIcon,order:2};return{label:'Групповая терапия',icon:historyTherapyIcon,order:1}}
  function historyHeaderMeta(kind){if(kind==='morning')return{title:'Утренний отчёт',subtitle:'История утренних отчётов',empty:'Сохранённых утренних отчётов пока нет.'};if(kind==='evening')return{title:'Вечерний отчёт',subtitle:'История вечерних отчётов',empty:'Сохранённых вечерних отчётов пока нет.'};return{title:'Групповая терапия',subtitle:'История отчётов с терапии',empty:'Сохранённых отчётов с групповой терапии пока нет.'}}
  function closeHistoryModal(){$('reportHistoryModal').classList.add('hidden')}
  function makeHistoryReportSection(report){const meta=historyKindMeta(report.kind),section=document.createElement('section');section.className='report-history-day-report';const head=document.createElement('div');head.className='report-history-day-head';const label=document.createElement('div');label.className='report-history-day-kind';label.innerHTML=meta.icon+'<span>'+meta.label+'</span>';const copy=document.createElement('button');copy.type='button';copy.className='report-copy-btn';copy.setAttribute('aria-label','Скопировать отчёт');copy.title='Скопировать отчёт';copy.innerHTML=historyCopyIcon;const text=document.createElement('div');text.className='report-history-day-text';if(report.kind==='psychology'&&window.MedsiPsychologyFormatter&&typeof MedsiPsychologyFormatter.render==='function')MedsiPsychologyFormatter.render(text,String(report.text||''));else text.textContent=String(report.text||'');copy.onclick=()=>copyText(report.text||'',copy);head.append(label,copy);section.append(head,text);return section}
  function openHistoryDay(date){const reports=(reportHistoryByDate[date]||[]).slice().sort((a,b)=>historyKindMeta(a.kind).order-historyKindMeta(b.kind).order);if(!reports.length)return;selectedHistoryDate=date;$('reportHistoryModalTitle').textContent=historyDateLabel(date);const body=$('reportHistoryModalReports');body.replaceChildren(...reports.map(makeHistoryReportSection));$('reportHistoryModal').classList.remove('hidden');renderReportCalendar()}
  function renderReportCalendar(){const list=$('reportHistoryList'),year=Math.floor(reportHistoryMonth/12),month=((reportHistoryMonth%12)+12)%12;list.innerHTML='';const calendar=document.createElement('div');calendar.className='report-calendar';const nav=document.createElement('div');nav.className='report-calendar-nav';const previous=document.createElement('button'),next=document.createElement('button'),title=document.createElement('div');previous.type=next.type='button';previous.className=next.className='report-calendar-arrow';previous.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>';next.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg>';previous.setAttribute('aria-label','Предыдущий месяц');next.setAttribute('aria-label','Следующий месяц');previous.disabled=reportHistoryMonth<=reportHistoryMinMonth;next.disabled=reportHistoryMonth>=reportHistoryMaxMonth;previous.onclick=()=>{reportHistoryMonth--;selectedHistoryDate='';renderReportCalendar()};next.onclick=()=>{reportHistoryMonth++;selectedHistoryDate='';renderReportCalendar()};title.className='report-calendar-title';title.textContent=historyMonthLabel(year,month);nav.append(previous,title,next);const weekdays=document.createElement('div');weekdays.className='report-calendar-weekdays';['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].forEach(value=>{const day=document.createElement('span');day.textContent=value;weekdays.appendChild(day)});const grid=document.createElement('div');grid.className='report-calendar-grid';const offset=(new Date(year,month,1).getDay()+6)%7,days=new Date(year,month+1,0).getDate(),total=Math.ceil((offset+days)/7)*7;for(let index=0;index<total;index++){if(index<offset||index>=offset+days){const blank=document.createElement('span');blank.className='report-calendar-blank';grid.appendChild(blank);continue}const number=index-offset+1,key=historyDateKey(year,month,number),reports=reportHistoryByDate[key]||[],hasMorning=reports.some(report=>report.kind==='morning'),hasEvening=reports.some(report=>report.kind==='evening'),hasPsychology=reports.some(report=>report.kind==='psychology'),day=document.createElement('button');day.type='button';day.className='report-calendar-day'+(reports.length?' has-reports':'')+(selectedHistoryDate===key?' is-selected':'');day.disabled=!reports.length;const types=[hasMorning?'утренний':'',hasPsychology?'групповая терапия':'',hasEvening?'вечерний':''].filter(Boolean);day.setAttribute('aria-label',historyDateLabel(key)+(types.length?', '+types.join(', '):', отчётов нет'));const numberEl=document.createElement('span');numberEl.className='report-calendar-number';numberEl.textContent=String(number);const marks=document.createElement('span');marks.className='report-calendar-marks';if(hasMorning)marks.insertAdjacentHTML('beforeend',historySunIcon);if(hasPsychology)marks.insertAdjacentHTML('beforeend',historyTherapyIcon);if(hasEvening)marks.insertAdjacentHTML('beforeend',historyMoonIcon);day.append(numberEl,marks);if(reports.length)day.onclick=()=>openHistoryDay(key);grid.appendChild(day)}calendar.append(nav,weekdays,grid);list.appendChild(calendar)}
  function renderReportHistory(reports){const list=$('reportHistoryList'),valid=[],kind=currentReportKind;reportHistoryByDate={};selectedHistoryDate='';for(const report of reports){const parts=historyDateParts(report&&report.reportDate);if(!parts||report.kind!==kind)continue;const date=historyDateKey(parts.year,parts.month,parts.day);if(!reportHistoryByDate[date])reportHistoryByDate[date]=[];if(!reportHistoryByDate[date].some(item=>item.kind===report.kind))reportHistoryByDate[date].push(report);valid.push({date,month:parts.year*12+parts.month})}list.innerHTML='';if(!valid.length){const empty=document.createElement('div');empty.className='report-history-empty';empty.textContent=historyHeaderMeta(kind).empty;list.appendChild(empty);return}valid.sort((a,b)=>a.date.localeCompare(b.date));reportHistoryMinMonth=Math.min(...valid.map(item=>item.month));reportHistoryMaxMonth=Math.max(...valid.map(item=>item.month));reportHistoryMonth=reportHistoryMaxMonth;renderReportCalendar()}
  async function openReportHistory(){const run=++historyRun,header=historyHeaderMeta(currentReportKind);setHeader(header.title,header.subtitle);$('reportHistoryError').classList.add('hidden');$('reportHistoryList').innerHTML='<div class="report-loading"><span class="report-loading-spinner"></span><span>Загружаем историю...</span></div>';show('screenReportHistory');try{const value=await readD1('/lab/report-history');if(run!==historyRun)return;renderReportHistory(Array.isArray(value.reports)?value.reports:[])}catch(e){if(run!==historyRun)return;$('reportHistoryList').innerHTML='';$('reportHistoryError').textContent=String(e&&e.message||e);$('reportHistoryError').classList.remove('hidden')}}
  async function openReport(kind,refreshOnly){
    const run=++reportRun;currentReportKind=kind;if(!refreshOnly){currentReportText='';setHeader(reportTitle(kind),'');
    $('reportDisclaimer').classList.toggle('hidden',kind==='psychology');$('reportCopyBtn').classList.add('hidden');$('reportHistoryBtn').classList.remove('hidden');
    $('reportContent').innerHTML='<div class="report-loading"><span class="report-loading-spinner"></span><span>Загружаем...</span></div>';
    $('reportError').classList.add('hidden');show('screenReport');hideReportBadge(kind);}
    const cached=reportCache[kind];if(cached)showReportResult(kind,cached);
    const result=await warmReport(kind,true);
    if(run!==reportRun||document.body.dataset.screen!=='screenReport')return;
    if(result)showReportResult(kind,result);
    else if(!cached){$('reportContent').textContent='';$('reportError').textContent='Восстанавливаем соединение…';$('reportError').classList.remove('hidden');}
    setTimeout(()=>{if(!document.hidden&&run===reportRun&&document.body.dataset.screen==='screenReport')openReport(kind,true)},!result?5000:result.hasReport?60000:15000);
  }
  function showSchedule(){setHeader('Режим дня','Расписание детского отделения.');show('screenSchedule')}
  async function openChat(){
    if(openingChat)return;openingChat=true;
    try{
      if(window.MedsiLoadParentChat)await window.MedsiLoadParentChat();
      const session=d1Session; // The chat owns connection recovery and stays visible while a session is renewed.
      if(!window.MedsiParentChatScreen)throw new Error('Чат не загрузился.');
      const readPending=markChatBadgeRead();show('screenChat');
      openingChat=false; // Going back must not lock reopening behind the previous network request.
      await MedsiParentChatScreen.open({session,phone:currentPhone,parentName,childName,readOnly:previewMode,getSession:force=>warmD1(force),confirmChatClosed:async()=>false,onBack:()=>{showChoose();if(!previewMode)readPending.then(()=>refreshParentMenu());}});
    }catch(e){alert(String(e&&e.message||e));}
    finally{openingChat=false;const btn=$('btnChat');btn.classList.remove('medsi-chat-opening');btn.querySelector('.medsi-chat-opening-spinner')?.remove();}
  }

  $('btnGoRegister').onclick=()=>showNames();$('btnGoAuth').onclick=()=>showAuth();$('startHelpBtn').onclick=()=>{const p=$('startHelpPanel'),open=p.classList.toggle('is-open');p.setAttribute('aria-hidden',open?'false':'true')};
  $('namesBackBtn').onclick=showStart;$('namesAuthBtn').onclick=showAuth;$('phoneRegBackBtn').onclick=showNames;$('authMainBackBtn').onclick=()=>{flowRun++;safeRemove(REAUTH_KEY);showStart()};$('showPhoneAuthBtn').onclick=()=>{$('phoneAuthFallback').classList.toggle('hidden');$('phoneErrorAuth').classList.add('hidden');if(!$('phoneAuthFallback').classList.contains('hidden'))$('phoneInputAuth').focus()};$('passkeyLoginBtn').onclick=loginWithPasskey;
  $('toPhoneReg').onclick=()=>{const pFirst=$('parentFirst').value.trim(),pLast=$('parentLast').value.trim(),cFirst=$('childFirst').value.trim(),cLast=$('childLast').value.trim(),err=$('namesError');if(!pFirst||!cFirst){err.textContent='Введите имя родителя и имя ребёнка.';err.classList.remove('hidden');return}if(!cLast){err.textContent='Введите фамилию ребёнка. Она может отличаться от фамилии родителя.';err.classList.remove('hidden');return}if(![pFirst,pLast,cFirst,cLast].filter(Boolean).every(isSingleWord)){err.textContent='В каждое поле вводите только имя или фамилию, без отчества.';err.classList.remove('hidden');return}err.classList.add('hidden');regParentName=[pFirst,pLast].filter(Boolean).join(' ');regChildName=[cFirst,cLast].filter(Boolean).join(' ');showPhoneReg()};
  $('registerBtn').onclick=register;$('authBtn').onclick=auth;$('btnChat').onclick=openChat;$('btnMorning').onclick=()=>openReport('morning');$('btnEvening').onclick=()=>openReport('evening');$('btnPsychology').onclick=()=>openReport('psychology');$('btnSchedule').onclick=showSchedule;
  $('reportCopyBtn').onclick=()=>copyText(currentReportText,$('reportCopyBtn'));$('reportHistoryBtn').onclick=openReportHistory;$('historyBackBtn').onclick=()=>{setHeader(reportTitle(currentReportKind),'');show('screenReport')};$('reportHistoryModalClose').onclick=closeHistoryModal;$('reportHistoryModal').onclick=e=>{if(e.target===$('reportHistoryModal'))closeHistoryModal()};
  $('authPendingBackBtn').onclick=()=>{flowRun++;safeRemove(REAUTH_KEY);showAuth()};
  $('reportBackBtn').onclick=()=>{const pending=reportReadPending[currentReportKind];showChoose();if(pending)pending.then(()=>refreshParentMenu())};$('scheduleBackBtn').onclick=showChoose;$('logoutBtn').onclick=()=>{if(['screenAuthPending','screenRegistrationPending'].includes(document.body.dataset.screen)){clearSession();safeRemove(REAUTH_KEY);safeRemove(REG_ATTEMPT_KEY);$('authRequestCode').textContent='••••';justRegistered=false;showStart();return}$('logoutModal').classList.remove('hidden')};$('logoutCancelBtn').onclick=()=>$('logoutModal').classList.add('hidden');$('logoutConfirmBtn').onclick=()=>{$('logoutModal').classList.add('hidden');clearSession();safeRemove(REAUTH_KEY);justRegistered=false;showStart()};
  ['phoneInputReg','phoneInputAuth'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')(id==='phoneInputReg'?register:auth)()}));
  function boot(){let preview=null;try{preview=JSON.parse(sessionStorage.getItem('medsi_parent_preview_once')||'null')}catch(_){}if(preview&&validPhone(preview.phone)&&preview.parentSession&&Number(preview.expiresAt)>Date.now()){previewMode=true;currentPhone=onlyDigits(preview.phone);parentSession=String(preview.parentSession);parentName=String(preview.parentName||'');childName=String(preview.childName||'');d1Session={token:parentSession,expiresAt:Number(preview.expiresAt)};document.body.classList.add('parent-preview-mode');const banner=document.createElement('div');banner.className='parent-preview-banner';banner.innerHTML='<span>Предварительный просмотр</span><button type="button">Вернуться в панель воспитателя</button>';banner.querySelector('button').onclick=()=>{sessionStorage.removeItem('medsi_parent_preview_once');location.assign('/tutors.html')};document.body.insertBefore(banner,document.body.firstChild);showChoose();refreshParentMenu();return}initPush();const ph=onlyDigits(safeGet(PHONE_KEY)||safeGet(LEGACY_PHONE_KEY)),session=safeGet(PARENT_SESSION_KEY);if(validPhone(ph)&&session){restoreSaved();return}const reauth=readJson(REAUTH_KEY);if(reauth&&validPhone(reauth.phone)&&reauth.requestId){if(!reauth.requestSecret){safeRemove(REAUTH_KEY);beginReauthorization(reauth.phone,true)}else runReauthorizationFlow(reauth,false);return}const registration=readJson(REG_ATTEMPT_KEY);if(registration&&validPhone(registration.phone)&&registration.attemptId){runRegistrationFlow(registration);return}showStart()}
  window.MedsiParentApp.refresh=refreshParentMenu;
  window.MedsiParentApp.helpersReady=()=>{initPush();syncPushIdentity();};
  function resume(){if(document.hidden||!currentPhone||!parentSession)return;if(document.body.dataset.screen==='screenChoose')refreshParentMenu();else if(document.body.dataset.screen==='screenReport')openReport(currentReportKind,true);}
  window.addEventListener('online',resume);window.addEventListener('pageshow',resume);document.addEventListener('visibilitychange',resume);
  boot();
  window.MedsiParentApp.ready=true;
})();
