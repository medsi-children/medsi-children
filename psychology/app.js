(function(){
  const APP_BASE_URL='/__session/api';
  const $=id=>document.getElementById(id);
  const TUTOR_KEY='medsi_tutor_session_v1',D1_KEY='medsi_psychology_d1_session_v1';
  let sendBusy=false,tutorToken='',d1Session=null,reportAttempt=null;
  function extractD1(res){return res&&res.d1Session&&res.d1Session.token?res.d1Session:null}

  function reportSubmissionId(){
    if(window.crypto&&typeof window.crypto.randomUUID==='function')return 'report_'+window.crypto.randomUUID().replace(/-/g,'');
    return 'report_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
  }
  function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
  async function callApi(method,args,timeoutMs){
    const readOnly=/^(get|list|verify|check)/i.test(String(method||''));
    const attempts=readOnly?2:1;let lastError;
    for(let attempt=0;attempt<attempts;attempt++){
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs||15000);
      try{const r=await fetch(APP_BASE_URL,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body:JSON.stringify({action:'api',method,args:args||[]}),cache:'no-store',signal:controller.signal});const raw=await r.text();let p;try{p=JSON.parse(raw)}catch(_){throw new Error('Сервер вернул некорректный ответ.')}if(!r.ok||!p||p.ok!==true)throw new Error((p&&p.message)||('HTTP '+r.status));clearTimeout(timer);return p.result}catch(e){clearTimeout(timer);lastError=controller.signal.aborted?new Error('TIMEOUT'):e;if(attempt+1<attempts)await delay(350)}
    }
    throw lastError||new Error('TIMEOUT');
  }

  function showError(text){const el=$('reportError');el.textContent=String(text||'');el.classList.toggle('hidden',!text)}

  function safeGet(key){try{return localStorage.getItem(key)||''}catch(_){return''}}
  function safeSet(key,value){try{localStorage.setItem(key,value)}catch(_){} }
  function loadD1(){try{const value=JSON.parse(safeGet(D1_KEY)||'null');if(value&&value.token&&Number(value.expiresAt||0)>Date.now()+30000)return value}catch(_){}return null}
  function saveD1(value){if(value&&value.token){d1Session=value;safeSet(D1_KEY,JSON.stringify(value))}return value}

  function showForm(){
    $('authScreen').classList.add('hidden');
    $('formScreen').classList.remove('hidden');
    $('text').focus();
  }

  function showAuth(message){
    $('formScreen').classList.add('hidden');
    $('authScreen').classList.remove('hidden');
    if(message){$('authError').textContent=message;$('authError').classList.remove('hidden')}
  }

  async function restoreTutorSession(){
    tutorToken=safeGet(TUTOR_KEY).trim();
    if(!tutorToken){showAuth();return}
    const cachedSession=loadD1();
    if(cachedSession){d1Session=cachedSession;showForm();return}
    try{
      const res=await callApi('verifyTutorSession',[tutorToken],17000);
      if(res&&res.ok){saveD1(extractD1(res));showForm();return}
      if(res&&res.ok===false){tutorToken='';safeSet(TUTOR_KEY,'');showAuth();return}
    }catch(_){ }
    showAuth('Связь временно прервалась. Сохранённый вход не потерян — откройте страницу ещё раз.');
  }

  async function authenticate(){
    const login=$('authLogin').value.trim(),password=$('authPassword').value;
    const btn=$('authBtn'),error=$('authError');
    error.classList.add('hidden');
    if(!login||!password){error.textContent='Введите логин и пароль.';error.classList.remove('hidden');return}
    btn.disabled=true;btn.textContent='Проверяем…';
    try{
      const res=await callApi('verifyTutorAccess',[login,password],18000);
      if(!res||!res.ok)throw new Error((res&&res.message)||'Неверный логин или пароль.');
      tutorToken=String(res.token||'');
      if(!tutorToken)throw new Error('Сервер не выдал сессию.');
      saveD1(extractD1(res));
      safeSet(TUTOR_KEY,tutorToken);showForm();
    }catch(e){error.textContent=String(e&&e.message||e)==='TIMEOUT'?'Сервер долго не отвечает. Попробуйте ещё раз.':String(e&&e.message||e);error.classList.remove('hidden')}
    finally{btn.disabled=false;btn.textContent='Войти'}
  }

  // The Timeweb adapter remains responsible for tutor login/session renewal.
  // Report writes and receipt checks use only the canonical Timeweb PostgreSQL API.
  async function ensureReportSession(){
    if(d1Session&&d1Session.token&&Number(d1Session.expiresAt||0)>Date.now()+30000)return d1Session;
    if(!tutorToken)throw new Error('Сессия завершилась. Войдите в систему повторно.');
    const verified=await callApi('verifyTutorSession',[tutorToken],17000);
    if(!verified?.ok)throw new Error('Сессия завершилась. Войдите в систему повторно.');
    const fresh=saveD1(extractD1(verified));
    if(!fresh||!fresh.token)throw new Error('Сервер не выдал сессию отправки. Обновите страницу.');
    return fresh;
  }

  function uncertainDelivery(error){
    const code=String(error?.code||''),status=Number(error?.status||0);
    return ['NETWORK','TIMEOUT','BAD_RESPONSE'].includes(code)||
      [408,425,429,500,502,503,504].includes(status);
  }

  async function checkReportReceipt(session,submissionId){
    if(!window.MedsiOverlayTransport?.reportStatus)return false;
    try{
      // A read-only check, with a short UI deadline. Never POST to another route.
      const result=await Promise.race([
        MedsiOverlayTransport.reportStatus(session,submissionId),
        delay(7000).then(()=>null)
      ]);
      return !!(result&&result.ok===true&&result.submissionId===submissionId&&
        (result.status==='completed'||result.status==='saved'));
    }catch(_){return false}
  }

  async function sendReport(){
    if(sendBusy)return;
    const text=$('text').value,btn=$('sendBtn');showError('');
    if(!text.trim()){showError('Пустой текст отчёта.');return}
    if(!reportAttempt||reportAttempt.text!==text)
      reportAttempt={text,id:reportSubmissionId()};
    const submissionId=reportAttempt.id;
    sendBusy=true;btn.disabled=true;btn.textContent='Отправляем…';
    try{
      if(!window.MedsiOverlayTransport?.reportSubmit)
        throw new Error('Модуль отправки не загрузился. Обновите страницу.');
      const session=await ensureReportSession();
      let receipt;
      try{
        // One direct write attempt. The same ID is retained for manual retry.
        // The educator panel keeps its existing retry behavior unchanged.
        receipt=await MedsiOverlayTransport.reportSubmit(session,{
          reportType:'psychology',text,submissionId
        },{retryTransientWrite:false});
      }catch(error){
        if(!uncertainDelivery(error))throw error;
        btn.textContent='Проверяем сохранение…';
        if(await checkReportReceipt(session,submissionId)){
          reportAttempt=null;showDone();return;
        }
        throw Object.assign(new Error(
          'Связь прервалась. Сохранение пока не подтверждено. Проверьте исходные отчёты; '+
          'если записи нет, нажмите «Отправить» ещё раз. Повтор использует тот же идентификатор.'
        ),{code:'UNCONFIRMED'});
      }
      if(receipt?.ok===true&&receipt.accepted===true&&receipt.submissionId===submissionId){
        reportAttempt=null;showDone();return;
      }
      btn.textContent='Проверяем сохранение…';
      if(await checkReportReceipt(session,submissionId)){
        reportAttempt=null;showDone();return;
      }
      throw new Error('Не удалось подтвердить сохранение. Проверьте исходные отчёты перед повторной отправкой.');
    }catch(error){
      const code=String(error?.code||''),status=Number(error?.status||0);
      if(status===404||code==='HTTP-404'){
        showError('Ошибка HTTP 404: маршрут отправки отчёта недоступен на сервере. '+
          'Запасная отправка отключена. Сообщите техподдержке; текст отчёта сохранён в форме.');
      }else if(code==='TIMEOUT'||String(error?.message||'')==='TIMEOUT'){
        showError('Сервер отвечает слишком долго. Проверьте исходные отчёты перед повторной отправкой.');
      }else{
        showError(String(error?.message||error));
      }
    }finally{
      sendBusy=false;btn.disabled=false;btn.textContent='Отправить';
    }
  }

  function showDone(){$('formScreen').classList.add('hidden');$('doneScreen').classList.remove('hidden')}

  $('authBtn').addEventListener('click',authenticate);
  $('authPassword').addEventListener('keydown',e=>{if(e.key==='Enter')authenticate()});
  $('sendBtn').addEventListener('click',sendReport);
  $('againBtn').addEventListener('click',()=>{$('text').value='';$('doneScreen').classList.add('hidden');$('formScreen').classList.remove('hidden');$('text').focus()});
  restoreTutorSession();
})();
