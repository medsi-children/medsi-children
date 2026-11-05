(function(){
  const APP_BASE_URL='/__session/api';
  const TUTOR_KEY='medsi_tutor_session_v1';
  const D1_KEY='medsi_d1_educator_session_v1';
  const DELETION_KEY='medsi_parent_deletions_v1';
  const $=id=>document.getElementById(id);
  let tutorToken='';
  let d1Session=null;
  let d1RefreshPromise=null;
  let d1WarmTimer=null;
  let overlay=null;
  let overlayCleanup=null;
  let parentsCache=[];
  let parentsSignature='';
  let parentsRequest=null;
  let authBusy=false;
  let authVerifyInFlight=false;
  let authRetryTimer=null;
  let reportAttempt=null;
  let deletionStatusTimer=null;

  function safeGet(key){try{return localStorage.getItem(key)||''}catch(_){return''}}
  function safeSet(key,val){try{localStorage.setItem(key,val)}catch(_){}}
  function safeRemove(key){try{localStorage.removeItem(key)}catch(_){}}
  function savedDeletionIds(){try{const value=JSON.parse(safeGet(DELETION_KEY)||'[]');return Array.isArray(value)?value:[]}catch(_){return[]}}
  function saveDeletionIds(ids){safeSet(DELETION_KEY,JSON.stringify((ids||[]).slice(-20)))}
  function loadD1(){try{const s=JSON.parse(safeGet(D1_KEY)||'null');return s&&s.token&&Number(s.expiresAt||0)>Date.now()+30000?s:null}catch(_){return null}}
  function extractD1(res){if(!res)return null;if(res.d1Session&&res.d1Session.token)return res.d1Session;if(res.session&&res.session.token)return res.session;if(res.token)return res;return null}
  function saveAuth(token,session){tutorToken=String(token||'');if(tutorToken)safeSet(TUTOR_KEY,tutorToken);if(session&&session.token){if(d1Session)Object.assign(d1Session,session);else d1Session={...session};safeSet(D1_KEY,JSON.stringify(d1Session))}}
  function clearAuth(){tutorToken='';d1Session=null;d1RefreshPromise=null;if(d1WarmTimer){clearTimeout(d1WarmTimer);d1WarmTimer=null}if(authRetryTimer){clearTimeout(authRetryTimer);authRetryTimer=null}safeRemove(TUTOR_KEY);safeRemove(D1_KEY)}
  function phone10(v){return String(v||'').replace(/\D+/g,'').slice(-10)}
  function displayPhone(v){const p=phone10(v);return p?'8'+p:''}
  function parentSig(rows){return (rows||[]).map(r=>[phone10(r.phone),r.parentName||'',r.childName||'',r.relationship||''].join('|')).sort().join('~')}

  function timeoutPromise(ms){return new Promise((_,reject)=>setTimeout(()=>reject(new Error('TIMEOUT')),ms))}
  function reportSubmissionId(){
    if(window.crypto&&typeof window.crypto.randomUUID==='function')return 'report_'+window.crypto.randomUUID().replace(/-/g,'');
    return 'report_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
  }
  function parentDeletionId(){
    if(window.crypto&&typeof window.crypto.randomUUID==='function')return 'delete_'+window.crypto.randomUUID().replace(/-/g,'');
    return 'delete_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12);
  }
  async function callApi(method,args,timeoutMs){
    const readOnly=/^(get|list|verify|check)/i.test(String(method||''));
    const attempts=method==='verifyTutorSession'?1:(readOnly?2:1);
    const sessionMethod=['verifyTutorAccess','verifyTutorSession','getD1ChatSession'].includes(method);
    let lastError;
    for(let attempt=0;attempt<attempts;attempt++){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),sessionMethod?Math.max(timeoutMs||0,method==='verifyTutorAccess'?30000:22000):(timeoutMs||15000));
      try{
        const body=JSON.stringify({action:'api',method,args:args||[]});
        const r=await fetch(APP_BASE_URL,{method:'POST',headers:{'content-type':'text/plain;charset=UTF-8'},body,cache:'no-store',signal:controller.signal});
        const raw=await r.text();let p;try{p=JSON.parse(raw)}catch(_){throw new Error('Сервер вернул некорректный ответ.')}
        if(!r.ok||!p||p.ok!==true)throw new Error((p&&p.message)||('HTTP '+r.status));
        clearTimeout(timer);return p.result;
      }catch(e){clearTimeout(timer);lastError=controller.signal.aborted?new Error('TIMEOUT'):e;if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,350))}
    }
    throw lastError||new Error('TIMEOUT');
  }

  function setAuthError(text){const el=$('tutorAuthError');el.textContent=String(text||'');el.classList.toggle('hidden',!text)}
  function showGate(checking){
    const gate=$('tutorAuthGate');gate.classList.remove('hidden');gate.classList.toggle('checking',!!checking);
    $('authChecking').classList.toggle('hidden',!checking);$('authForm').classList.toggle('hidden',!!checking);
    if(!checking)setTimeout(()=>{const active=document.activeElement;if(!$('tutorAuthGate').classList.contains('hidden')&&!$('authForm').contains(active))$('tutorLogin').focus();},30);
  }
  function hideGate(){$('tutorAuthGate').classList.add('hidden');$('tutorAuthGate').classList.remove('checking')}
  function setCheckingText(text){$('authCheckingText').textContent=text}
  function enterApp(){
    try{startApp();hideGate();return true}
    catch(error){
      showGate(true);
      setCheckingText('Не удалось полностью загрузить панель. Проверьте соединение и обновите страницу.');
      $('authRetry').classList.remove('hidden');
      console.error('TUTOR_UI_START_FAILED',error);
      return false;
    }
  }

  function requestFreshD1(){
    if(d1RefreshPromise)return d1RefreshPromise;
    d1RefreshPromise=(async()=>{
      const result=await callApi('verifyTutorSession',[tutorToken],17000);
      if(result&&result.ok===false){clearAuth();showGate(false);throw new Error('Сохранённый вход завершился. Введите логин и пароль.');}
      const session=extractD1(result);
      if(!session||!session.token)throw new Error('Не удалось обновить сессию чата.');
      saveAuth(tutorToken,session);return session;
    })().finally(()=>{d1RefreshPromise=null});
    return d1RefreshPromise;
  }
  function scheduleD1Warm(){
    if(!tutorToken)return;
    if(d1WarmTimer)clearTimeout(d1WarmTimer);
    d1WarmTimer=setTimeout(()=>{
      d1WarmTimer=null;
      const expiry=Number(d1Session&&d1Session.expiresAt||0);
      if(d1Session&&expiry>Date.now()+10*60*1000)return;
      requestFreshD1().then(session=>{if(session){prewarmParents();refreshUnreadBadge()}}).catch(()=>{});
    },80);
  }
  async function refreshSavedSessionInBackground(){
    try{
      const session=await requestFreshD1();
      if(session){saveAuth(tutorToken,session);prewarmParents();refreshUnreadBadge()}
    }catch(_){
      // Keep the already restored menu visible; the next foreground action
      // or scheduled refresh can try again without losing the token.
    }
  }
  async function verifySaved(){
    if(authVerifyInFlight)return;
    if(authRetryTimer){clearTimeout(authRetryTimer);authRetryTimer=null}
    tutorToken=String(safeGet(TUTOR_KEY)||'');d1Session=loadD1();
    if(!tutorToken){showGate(false);return}
    if(d1Session&&d1Session.token){
      if(enterApp()&&Number(d1Session.expiresAt||0)<=Date.now()+10*60*1000){
        refreshSavedSessionInBackground();
      }
      return;
    }
    // A saved tutor token is enough to restore the lightweight menu shell.
    // Do not keep the whole panel behind a blank checking screen while the
    // D1 session is refreshed through a slower mobile connection.
    if(enterApp()){
      refreshSavedSessionInBackground();
      return;
    }
    $('authRetry').classList.add('hidden');
    showGate(true);setCheckingText('Проверяем сохранённый вход…');authVerifyInFlight=true;
    try{
      const res=await callApi('verifyTutorSession',[tutorToken],17000);
      if(res&&res.ok===false){clearAuth();showGate(false);setAuthError('Сохранённый вход завершился. Введите логин и пароль.');return}
      if(!res||res.ok!==true)throw new Error('Не удалось проверить сохранённый вход.');
      const session=extractD1(res);
      if(session)saveAuth(tutorToken,session);
      if(enterApp()&&!session)scheduleD1Warm();
    }catch(_){
      setCheckingText('Связь временно прервалась. Повторяем проверку автоматически — сохранённый вход не потерян.');
      authRetryTimer=setTimeout(verifySaved,5000);
    }finally{authVerifyInFlight=false}
  }

  async function submitLogin(){
    if(authBusy)return;const login=$('tutorLogin').value.trim(),password=$('tutorPassword').value;
    if(!login||!password){setAuthError('Введите логин и пароль.');return}
    authBusy=true;$('tutorLoginBtn').disabled=true;$('tutorLoginBtn').textContent='Проверяем…';setAuthError('');
    try{
      const res=await callApi('verifyTutorAccess',[login,password],30000);
      if(!res||!res.ok||!res.token)throw new Error((res&&res.message)||'Не удалось войти.');
      saveAuth(String(res.token),extractD1(res));$('tutorPassword').value='';
      if(enterApp())scheduleD1Warm();
    }catch(e){setAuthError(String(e&&e.message||e)==='TIMEOUT'?'Сервер долго не отвечает. Попробуйте ещё раз.':String(e&&e.message||e))}
    finally{authBusy=false;$('tutorLoginBtn').disabled=false;$('tutorLoginBtn').textContent='Войти в систему'}
  }

  function animateScreen(el){if(!el)return;el.classList.remove('web-screen-enter');void el.offsetWidth;el.classList.add('web-screen-enter');setTimeout(()=>el.classList.remove('web-screen-enter'),340)}
  function setScreen(name,title,meta){
    ['screenChoose','screenForm','screenDone','screenPhones'].forEach(id=>$(id).classList.toggle('hidden',id!==name));
    document.body.dataset.screen=name==='screenForm'?'report-'+($('btnSend').dataset.type||''):name;
    $('title').textContent=title||'Медси Бот';$('meta').textContent=meta||'Что хотите сделать?';animateScreen($(name));window.scrollTo(0,0)
  }
  function showMenu(){if(deletionStatusTimer){clearTimeout(deletionStatusTimer);deletionStatusTimer=null}setScreen('screenChoose','Медси Бот','Что хотите сделать?');refreshUnreadBadge();refreshDeletionJobs();scheduleD1Warm()}
  function openReport(type){scheduleD1Warm();$('btnSend').dataset.type=type;$('reportError').classList.add('hidden');$('reportError').classList.remove('report-validation-warning');$('text').value='';const spec=type==='morning'?['Утренний отчёт','Вставьте текст утреннего отчёта.']:type==='evening'?['Вечерний отчёт','Вставьте текст вечернего отчёта.']:['Психотерапия','Вставьте отчёт по групповой терапии.'];setScreen('screenForm',spec[0],spec[1])}
  async function submitReportPayload(type,text,submissionId) {
    if (!tutorToken || !['morning','evening','psychology'].includes(type) || !String(text).trim()) throw new Error('Некорректный отчёт.');
    const validator=window.MedsiReportValidation;
    if(!validator)throw new Error('Не загрузилась проверка отчёта. Обновите страницу и попробуйте ещё раз.');
    const validation=validator.validate(type,text);
    if(!validation.ok)throw Object.assign(new Error(validation.message),{code:validation.code});
    if(!window.MedsiOverlayTransport||!MedsiOverlayTransport.reportSubmit)throw new Error('Не загрузилась отправка отчёта. Обновите страницу и попробуйте ещё раз.');
    const session=await ensureD1Fresh();
    // A receipt confirms durable server storage. Apps Script runs independently
    // through the Worker and its scheduled retries after the browser closes.
    const queued=await MedsiOverlayTransport.reportSubmit(session,{reportType:type,text,submissionId});
    if(!queued||queued.ok!==true||queued.accepted!==true||queued.submissionId!==submissionId)throw new Error('Не удалось подтвердить сохранение отчёта. Попробуйте отправить ещё раз.');
    return {accepted:true,submissionId};
  }
  async function sendReport(){
    const type=$('btnSend').dataset.type,text=$('text').value,btn=$('btnSend');
    if(btn.disabled)return;
    $('reportError').classList.add('hidden');$('reportError').classList.remove('report-validation-warning');if(!text.trim()){showReportError('Пустой текст отчёта.');return}
    // An uncertain network result must reuse the same ID on another attempt.
    if(!reportAttempt||reportAttempt.type!==type||reportAttempt.text!==text)reportAttempt={type,text,id:reportSubmissionId()};
    btn.disabled=true;btn.textContent='Отправляем…';
    try { await submitReportPayload(type,text,reportAttempt.id); reportAttempt=null;showReportSent(); }
    catch(e){const message=String(e&&e.message||e);showReportError(['TIMEOUT','NETWORK','BAD_RESPONSE'].includes(e&&e.code)?'Связь прервалась. Нажмите «Отправить» ещё раз — тот же отчёт не продублируется.':message,e&&e.code==='REPORT_FORMAT_ERROR')}
    finally{btn.disabled=false;btn.textContent='Отправить'}
  }
  function showReportSent(){$('doneText').textContent='Готово.';setScreen('screenDone','Готово','Отчёт сохранён. Можно закрыть приложение.')}
  function showReportError(text,isFormatError=false){const el=$('reportError');el.textContent=(isFormatError?'⚠️ ':'')+text;el.classList.toggle('report-validation-warning',!!isFormatError);el.classList.remove('hidden')}

  async function prewarmParents(){
    try{await refreshPhones()}catch(_){}
  }
  function refreshPhones(){
    if(parentsRequest)return parentsRequest;
    parentsRequest=(async()=>{
      if(!window.MedsiOverlayTransport)throw new Error('Не загрузился модуль списка детей. Обновите страницу.');
      const session=await ensureD1Fresh();
      const res=await MedsiOverlayTransport.parents(session);
      if(!Array.isArray(res&&res.parents))throw new Error('Сервер не вернул список детей. Повторите попытку.');
      parentsCache=res.parents.map(r=>({phone:r.phone||'',parentName:r.parentName||'',childName:r.childName||'',relationship:r.relationship||'Родитель'}));
      parentsSignature=parentSig(parentsCache);return parentsCache;
    })().finally(()=>{parentsRequest=null});
    return parentsRequest;
  }
  async function copyPhone(phone,btn){
    const value=String(phone||'').trim();if(!value)return;
    try{await navigator.clipboard.writeText(value);const old=btn.textContent;btn.textContent='Скопировано';setTimeout(()=>btn.textContent=old,1000)}
    catch(_){const ta=document.createElement('textarea');ta.value=value;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();const old=btn.textContent;btn.textContent='Скопировано';setTimeout(()=>btn.textContent=old,1000)}
  }
  function renderPhones(rows){
    const box=$('phonesList');if(!box)return;box.replaceChildren();
    if(!rows||!rows.length){const empty=document.createElement('div');empty.className='chat-empty';empty.textContent='Нет родителей.';box.appendChild(empty);return}
    rows.forEach((r,index)=>{
      const card=document.createElement('div');card.className='phone-card card-enter';card.style.animationDelay=Math.min(index*24,160)+'ms';
      const title=document.createElement('div');title.className='phone-card-title';title.textContent=r.childName||'Без имени ребёнка';
      const meta=document.createElement('div');meta.className='phone-card-meta';
      const parentLine=document.createElement('div');parentLine.textContent=(r.relationship||'Родитель')+': '+(r.parentName||'—');
      const phoneLine=document.createElement('div');phoneLine.append('Номер телефона: ');const strong=document.createElement('span');strong.className='phone-number-strong';strong.textContent=displayPhone(r.phone)||'—';phoneLine.appendChild(strong);meta.append(parentLine,phoneLine);
      const actions=document.createElement('div');actions.className='phone-card-actions';
      const copy=document.createElement('button');copy.type='button';copy.className='btn btn-teal phone-action-btn';copy.textContent='Скопировать';copy.onclick=()=>copyPhone(displayPhone(r.phone),copy);
      const call=document.createElement('a');call.className='btn btn-mint phone-action-btn';call.href='tel:'+String(r.phone||'').replace(/\D+/g,'');call.textContent='Позвонить';
      // Deletion belongs in chats, Settings and the roster.
      actions.append(copy,call);card.append(title,meta,actions);box.appendChild(card);
    });
  }
  function renderDeletionJobs(rows){
    const box=$('parentDeletionJobs');if(!box||typeof box.replaceChildren!=='function')return;box.replaceChildren();
    const jobs=Array.isArray(rows)?rows.filter(job=>job.status==='failed'):[];box.classList.toggle('hidden',!jobs.length);
    jobs.forEach(job=>{
      const item=document.createElement('div');item.className='parent-deletion-job status error';
      const label=document.createElement('span');label.textContent='Не удалось завершить удаление: '+(job.childName||displayPhone(job.phone)||'ребёнок');item.appendChild(label);
      const reason=String(job.message||'').trim();if(reason){const detail=document.createElement('span');detail.className='parent-deletion-error-detail';detail.textContent=reason;item.appendChild(detail)}
      const retry=document.createElement('button');retry.type='button';retry.className='btn btn-teal phone-action-btn';retry.textContent='Повторить';
      retry.onclick=async()=>{retry.disabled=true;try{const session=await ensureD1Fresh();await MedsiOverlayTransport.retryParentDelete(session,job.operationId);await refreshDeletionJobs()}catch(e){retry.disabled=false;alert(String(e&&e.message||e))}};
      item.appendChild(retry);
      box.appendChild(item);
    });
  }
  async function refreshDeletionJobs(){
    if(deletionStatusTimer){clearTimeout(deletionStatusTimer);deletionStatusTimer=null}
    try{
      const session=await ensureD1Fresh();const result=await MedsiOverlayTransport.parentDeletePending(session);const jobs=result&&result.operations||[];
      const activeIds=new Set(jobs.map(job=>String(job.operationId||'')));
      saveDeletionIds(savedDeletionIds().filter(id=>activeIds.has(id)));
      renderDeletionJobs(jobs);
      const settingsOpen=!$('tutorSettingsDialog').classList.contains('hidden');
      if((document.body.dataset.screen==='screenPhones'||settingsOpen)&&jobs.some(job=>job.status==='pending'||job.status==='retry'||job.status==='processing')){
        deletionStatusTimer=setTimeout(refreshDeletionJobs,5000);
      }
    }catch(_){renderDeletionJobs([])}
  }
  function removePhoneCardOptimistically(row,card){
    const snapshot=parentsCache.slice();
    parentsCache=parentsCache.filter(x=>phone10(x.phone)!==phone10(row.phone));
    parentsSignature=parentSig(parentsCache);
    if(card){card.classList.add('phone-card-deleting');requestAnimationFrame(()=>card.classList.add('phone-card-deleting-go'));setTimeout(()=>{if(card.isConnected)card.remove()},230)}
    return snapshot;
  }
  function restorePhoneAfterFailedDelete(snapshot,message){
    parentsCache=snapshot;parentsSignature=parentSig(parentsCache);
    if(document.body.dataset.screen==='screenPhones')renderPhones(parentsCache);
    alert(String(message||'Не удалось удалить ребёнка.'));
  }
  async function deleteParent(row,card){
    const child=String(row.childName||'ребёнка').trim();
    if(!confirm('Удалить ребёнка '+child+' из бота?\n\nВся история сообщений будет удалена.'))return;
    const snapshot=removePhoneCardOptimistically(row,card);
    let operationId='';
    try{
      if(!window.MedsiOverlayTransport||!MedsiOverlayTransport.parentDelete)throw new Error('Не загрузилось быстрое удаление. Обновите страницу и попробуйте ещё раз.');
      const session=await ensureD1Fresh();
      operationId=parentDeletionId();
      saveDeletionIds(savedDeletionIds().concat(operationId));
      const res=await MedsiOverlayTransport.parentDelete(session,{phone:row.phone,operationId});
      if(!res||res.ok!==true||res.accepted!==true)throw new Error((res&&res.message)||'Не удалось подтвердить удаление.');
      window.MedsiEducatorPrewarm?.clear();
      refreshUnreadBadge();
      refreshDeletionJobs();
    }catch(e){
      if(operationId){try{const session=await ensureD1Fresh();const state=await MedsiOverlayTransport.parentDeleteStatus(session,operationId);if(state&&['pending','retry','processing','failed','completed'].includes(state.status)){refreshDeletionJobs();return}}catch(_){}}
      restorePhoneAfterFailedDelete(snapshot,e&&e.message||e)
    }
  }
  async function openPhones(){
    setScreen('screenPhones','Телефоны родителей','Здесь можно быстро скопировать номер или позвонить.');
    refreshDeletionJobs();
    const box=$('phonesList');const err=$('phonesError');err.classList.add('hidden');
    if(parentsCache.length){
      renderPhones(parentsCache);
      const shownSignature=parentsSignature||parentSig(parentsCache);
      refreshPhones().then(rows=>{if(document.body.dataset.screen==='screenPhones'&&parentSig(rows)!==shownSignature)renderPhones(rows)}).catch(()=>{});
      return;
    }
    box.innerHTML='<div class="phone-mini-loader" aria-label="Загрузка"></div>';
    try{const rows=await refreshPhones();if(document.body.dataset.screen==='screenPhones')renderPhones(rows)}catch(e){if(document.body.dataset.screen==='screenPhones'){box.replaceChildren();err.textContent=String(e&&e.message||e);err.classList.remove('hidden')}}
  }

  async function ensureD1Fresh(){if(d1Session&&Number(d1Session.expiresAt||0)>Date.now()+60000)return d1Session;return requestFreshD1()}
  window.MedsiEducatorSession=Object.freeze({
    get:ensureD1Fresh,
    renew(rejectedToken){
      if(d1Session&&d1Session.token!==rejectedToken)return ensureD1Fresh();
      return requestFreshD1();
    }
  });
  async function openChat(){try{const s=await ensureD1Fresh();overlay.open({type:'medsi:chat-overlay',action:'open',role:'educator',session:s})}catch(e){alert(String(e&&e.message||e))}}
  async function refreshUnreadBadge(){const badge=$('newParentMsgBanner');if(!d1Session||!window.MedsiOverlayTransport){badge.classList.add('hidden');return}try{const res=await MedsiOverlayTransport.chats(d1Session,'unread');const chats=Array.isArray(res&&res.chats)?res.chats:[];badge.classList.toggle('hidden',!chats.some(x=>!!x.hasUnread))}catch(_){badge.classList.add('hidden')}}

  function startApp(){
    if(document.body.dataset.started==='1'){showMenu();return}
    if(!window.MedsiChatOverlay||typeof MedsiChatOverlay.create!=='function'||!window.MedsiEducatorOverlayChat||typeof MedsiEducatorOverlayChat.mount!=='function')throw new Error('UI_MODULE_UNAVAILABLE');
    window.MEDSI_APP_BASE_URL=APP_BASE_URL;
    overlay=window.MedsiChatOverlay.create({frameId:'__no_iframe__',onOpen:(state,api)=>{if(overlayCleanup){try{overlayCleanup()}catch(_){}overlayCleanup=null}if(window.MedsiEducatorOverlayChat)overlayCleanup=MedsiEducatorOverlayChat.mount(api,state)||null},onClose:()=>{if(overlayCleanup){try{overlayCleanup()}catch(_){}overlayCleanup=null}showMenu()}});
    document.body.dataset.started='1';
    showMenu();prewarmParents()
  }

  const settingsDialog=$('tutorSettingsDialog');
  function fillSettingsSelect(select,rows,placeholder){select.replaceChildren();const first=document.createElement('option');first.value='';first.textContent=placeholder;select.appendChild(first);rows.forEach((row,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=[row.childName||'Без имени',row.parentName?'— '+row.parentName:'',row.relationship&&row.relationship!=='Родитель'?'('+row.relationship+')':''].filter(Boolean).join(' ');select.appendChild(option)})}
  async function refreshSettings(){const status=$('previewParentStatus');status.textContent='';$('previewChildSelect').innerHTML='<option value="">Загружаем список…</option>';$('deleteChildSelect').innerHTML='<option value="">Загружаем список…</option>';try{const rows=await refreshPhones();fillSettingsSelect($('previewChildSelect'),rows,'Выберите ребёнка');fillSettingsSelect($('deleteChildSelect'),rows,'Выберите ребёнка')}catch(error){fillSettingsSelect($('previewChildSelect'),[],'Не удалось загрузить список');fillSettingsSelect($('deleteChildSelect'),[],'Не удалось загрузить список');status.textContent=String(error&&error.message||error)}}
  async function updatePushControl(){const button=$('tutorPushToggle'),status=$('tutorPushStatus');try{if(!window.MedsiPush)throw new Error('Управление уведомлениями ещё загружается.');const enabled=await MedsiPush.getEnabled();button.textContent=enabled?'Отключить уведомления':'Включить уведомления';button.dataset.enabled=enabled?'1':'0';status.textContent=Notification.permission==='denied'&&!enabled?'Разрешите уведомления в настройках браузера.':''}catch(error){button.textContent='Уведомления недоступны';button.disabled=true;status.textContent=String(error&&error.message||'Не удалось проверить уведомления.')}}
  $('tutorSettingsOpen').addEventListener('click',()=>{settingsDialog.classList.remove('hidden');refreshSettings();refreshDeletionJobs();updatePushControl()});
  const closeSettings=()=>{settingsDialog.classList.add('hidden');if(deletionStatusTimer){clearTimeout(deletionStatusTimer);deletionStatusTimer=null}};
  $('tutorSettingsClose').addEventListener('click',closeSettings);
  settingsDialog.addEventListener('click',event=>{if(event.target===settingsDialog)closeSettings()});
  $('tutorPushToggle').addEventListener('click',async()=>{const button=$('tutorPushToggle');button.disabled=true;$('tutorPushStatus').textContent='';try{await MedsiPush.toggle();await updatePushControl()}catch(error){$('tutorPushStatus').textContent=String(error&&error.message||'Не удалось изменить уведомления.')}finally{button.disabled=false}});
  $('settingsDeleteChild').addEventListener('click',async()=>{const select=$('deleteChildSelect'),row=parentsCache[Number(select.value)];if(select.value===''||!row){alert('Сначала выберите ребёнка.');return}await deleteParent(row,null);refreshSettings()});
  $('previewParentButton').addEventListener('click',async()=>{const row=parentsCache[Number($('previewChildSelect').value)],button=$('previewParentButton'),status=$('previewParentStatus');if($('previewChildSelect').value===''||!row){status.textContent='Сначала выберите ребёнка.';return}button.disabled=true;status.textContent='Открываем панель…';try{const session=await ensureD1Fresh(),response=await fetch('/lab/parent-preview',{method:'POST',headers:{'content-type':'application/json','X-Medsi-Chat-Session':session.token},body:JSON.stringify({phone:row.phone}),cache:'no-store'}),result=await response.json();if(!response.ok||!result||!result.ok)throw new Error(result&&result.message||'Не удалось открыть профиль.');sessionStorage.setItem('medsi_parent_preview_once',JSON.stringify(result));location.assign('/')}catch(error){status.textContent=String(error&&error.message||error);button.disabled=false}});

  $('btnParentChats').addEventListener('click',openChat);$('btnMorning').addEventListener('click',()=>openReport('morning'));$('btnEvening').addEventListener('click',()=>openReport('evening'));$('btnPsychology').addEventListener('click',()=>openReport('psychology'));$('btnParentPhones').addEventListener('click',openPhones);$('btnBack').addEventListener('click',showMenu);$('btnPhonesBack').addEventListener('click',showMenu);$('btnAgain').addEventListener('click',showMenu);$('btnSend').addEventListener('click',sendReport);$('tutorLoginBtn').addEventListener('click',submitLogin);$('tutorPassword').addEventListener('keydown',e=>{if(e.key==='Enter')submitLogin()});
  // The assistant uses the same authenticated operations as the existing panel.
  window.MedsiTutorAdmin = Object.freeze({
    session: ensureD1Fresh,
    async parents() { if (!tutorToken) throw new Error('AUTH_REQUIRED'); await ensureD1Fresh(); return refreshPhones(); },
    async unread() { const session = await ensureD1Fresh(); const result = await MedsiOverlayTransport.chats(session, 'unread', {fresh:true}); return (result.chats || []).filter(row => row.hasUnread); },
    newSubmissionId: reportSubmissionId,
    submitReport: submitReportPayload,
    async sendParentMessage(target, text) {
      if (!tutorToken) throw new Error('AUTH_REQUIRED');
      const session = await ensureD1Fresh();
      return MedsiOverlayTransport.sendMessage(session, 'educator', target.phone, {
        type: 'text',
        text: String(text || '').trim()
      });
    },
    async deleteRecord(target) {
      if (!tutorToken) throw new Error('AUTH_REQUIRED');
      const rows = await refreshPhones();
      const current = rows.find(row => phone10(row.phone) === phone10(target.phone) && row.childName === target.childName && row.parentName === target.parentName);
      if (!current) throw new Error('RECORD_CHANGED');
      if(!window.MedsiOverlayTransport||!MedsiOverlayTransport.parentDelete)throw new Error('DELETE_UNAVAILABLE');
      const session=await ensureD1Fresh();
      const result=await MedsiOverlayTransport.parentDelete(session,{phone:current.phone,operationId:parentDeletionId()});
      if(!result||result.ok!==true||result.accepted!==true)throw new Error('DELETE_FAILED');
      parentsCache=parentsCache.filter(row=>phone10(row.phone)!==phone10(current.phone));
      parentsSignature=parentSig(parentsCache);
      window.MedsiEducatorPrewarm?.clear();
      refreshUnreadBadge();
      return result;
    },
    navigate(kind) {
      const actions = { chats: openChat, phones: openPhones, morning: () => openReport('morning'), evening: () => openReport('evening'), psychology: () => openReport('psychology') };
      if (!tutorToken || !actions[kind]) return;
      MedsiSmartBotWidget.navigate(actions[kind]);
    }
  });
  window.medsiForgetCachedChatToken=()=>{safeRemove(D1_KEY);d1Session=null;return true};window.medsiLogoutTutor=()=>{clearAuth();location.reload()};window.medsiTutorBootReady=true;verifySaved();
})();
