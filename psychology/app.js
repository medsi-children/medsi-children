(function(){
  const APP_BASE_URL='/__session/api';
  const $=id=>document.getElementById(id);
  const TUTOR_KEY='medsi_tutor_session_v1',D1_KEY='medsi_psychology_d1_session_v1';
  let sendBusy=false,tutorToken='',d1Session=null;
  function extractD1(res){return res&&res.d1Session&&res.d1Session.token?res.d1Session:null}

  function timeoutPromise(ms){return new Promise((_,reject)=>setTimeout(()=>reject(new Error('TIMEOUT')),ms))}
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

  async function sendReport(){
    if(sendBusy)return;
    const text=$('text').value,btn=$('sendBtn');showError('');
    if(!text.trim()){showError('Пустой текст отчёта.');return}
    const submissionId=reportSubmissionId();
    sendBusy=true;btn.disabled=true;btn.textContent='Отправляем…';
    try{
      if(d1Session&&window.MedsiOverlayTransport&&MedsiOverlayTransport.reportSubmit){
        try{
          const queued=await MedsiOverlayTransport.reportSubmit(d1Session,{reportType:'psychology',text,submissionId});
          if(queued&&queued.accepted){showDone();return}
        }catch(_){ /* fallback to the existing idempotent Apps Script route */ }
      }
      let stopped=false;
      const request=callApi('appendReport',[{reportType:'psychology',text,submissionId},tutorToken],30000)
        .then(value=>({source:'request',value}),error=>({source:'request',error}));
      const acceptance=waitForAcceptance(submissionId,()=>stopped)
        .then(value=>({source:'acceptance',value}),error=>({source:'acceptance',error}));
      const first=await Promise.race([request,acceptance]);
      if(first.source==='acceptance'&&first.value){showDone();return}
      let result=first;
      if(first.source==='request')stopped=true;
      else result=await request;
      if(result.error&&String(result.error&&result.error.message||result.error)!=='TIMEOUT')throw result.error;
      let res=result.value||null;
      if(!res||res.processing){btn.textContent='Проверяем результат…';res=await recoverSubmission(submissionId,text)}
      if(!res||!res.ok)throw new Error((res&&res.message)||'Не удалось отправить отчёт.');
      showDone();
    }catch(e){
      const message=String(e&&e.message||e);
      showError(message==='TIMEOUT'?'Сервер отвечает дольше обычного. Отчёт не нужно отправлять повторно.':message);
    }finally{sendBusy=false;btn.disabled=false;btn.textContent='Отправить'}
  }

  function showDone(){$('formScreen').classList.add('hidden');$('doneScreen').classList.remove('hidden')}

  async function waitForAcceptance(submissionId,shouldStop){
    const deadline=Date.now()+20000;await delay(700);
    while(Date.now()<deadline&&!(shouldStop&&shouldStop())){
      try{
        const status=await callApi('getReportSubmissionStatus',[submissionId,tutorToken],7000);
        if(status&&(status.status==='saved'||status.status==='completed'))return status;
        if(status&&status.status==='failed')throw new Error(status.message||'Не удалось отправить отчёт.');
      }catch(e){if(String(e&&e.message||e)!=='TIMEOUT')throw e}
      await delay(700);
    }
    return null;
  }

  async function recoverSubmission(submissionId,text){
    const deadline=Date.now()+120000;let retried=false,notFoundCount=0;
    while(Date.now()<deadline){
      await delay(2200);
      let status=null;
      try{status=await callApi('getReportSubmissionStatus',[submissionId,tutorToken],12000)}catch(e){if(String(e&&e.message||e)!=='TIMEOUT')throw e;continue}
      if(status&&(status.status==='saved'||status.status==='completed'))return status.result||{ok:true};
      if(status&&status.status==='failed')throw new Error(status.message||'Не удалось отправить отчёт.');
      if(status&&status.status==='not_found'&&++notFoundCount>=2&&!retried){
        retried=true;
        let retry=null;
        try{retry=await callApi('appendReport',[{reportType:'psychology',text,submissionId},tutorToken],30000)}catch(e){if(String(e&&e.message||e)!=='TIMEOUT')throw e}
        if(retry&&retry.ok&&!retry.processing)return retry;
        if(retry&&!retry.ok)throw new Error(retry.message||'Не удалось отправить отчёт.');
      }
    }
    throw new Error('Сервер отвечает дольше обычного. Отчёт продолжает обрабатываться; не отправляйте его повторно.');
  }

  $('authBtn').addEventListener('click',authenticate);
  $('authPassword').addEventListener('keydown',e=>{if(e.key==='Enter')authenticate()});
  $('sendBtn').addEventListener('click',sendReport);
  $('againBtn').addEventListener('click',()=>{$('text').value='';$('doneScreen').classList.add('hidden');$('formScreen').classList.remove('hidden');$('text').focus()});
  restoreTutorSession();
})();
