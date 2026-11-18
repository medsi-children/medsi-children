(function(){
  'use strict';
  const tile=document.getElementById('medsiBroadcastCard');
  if(!tile||document.getElementById('medsiBroadcastDialog'))return;
  const overlay=document.createElement('div');
  overlay.id='medsiBroadcastDialog';
  overlay.className='medsi-broadcast-backdrop hidden';
  overlay.setAttribute('role','dialog');
  overlay.setAttribute('aria-modal','true');
  overlay.setAttribute('aria-labelledby','medsiBroadcastTitle');
  overlay.innerHTML=`
    <section class="medsi-broadcast-card">
      <header class="medsi-broadcast-head">
        <div><h2 id="medsiBroadcastTitle">Рассылка родителям</h2></div>
        <button id="medsiBroadcastClose" type="button" aria-label="Закрыть">×</button>
      </header>
      <div class="medsi-broadcast-content">
        <p id="medsiBroadcastAudience" class="medsi-broadcast-audience" role="status">Проверяем список родителей…</p>
        <label for="medsiBroadcastText">Текст сообщения</label>
        <textarea id="medsiBroadcastText" rows="6" maxlength="4000" placeholder="Напишите объявление для родителей…"></textarea>
        <p id="medsiBroadcastFeedback" class="medsi-broadcast-feedback" role="status"></p>
        <button id="medsiBroadcastSend" class="medsi-broadcast-send" type="button" disabled>Проверяем получателей…</button>
      </div>
    </section>`;
  document.body.appendChild(overlay);
  const id=x=>document.getElementById(x);
  const audience=id('medsiBroadcastAudience'),text=id('medsiBroadcastText');
  const feedback=id('medsiBroadcastFeedback'),send=id('medsiBroadcastSend');
  const closeButton=id('medsiBroadcastClose');
  let snapshot=null,operationId='',locked=false,busy=false,completed=false;
  const freshId=()=>typeof crypto!=='undefined'&&crypto.randomUUID
    ?'bulk_'+crypto.randomUUID().replace(/-/g,'')
    :'bulk_'+Date.now().toString(36)+Math.random().toString(36).slice(2);
  async function request(path,body){
    const session=await window.MedsiEducatorSession.get();
    const response=await fetch(path,{method:body?'POST':'GET',
      headers:{'X-Medsi-Chat-Session':session.token,...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});
    let data=null;
    try{data=await response.json()}catch(_){}
    if(!data||!data.ok||!response.ok)throw new Error(data?.message||'Не удалось связаться с сервером.');
    return data;
  }
  const setBusy=value=>{busy=value;closeButton.disabled=value;send.disabled=value||!snapshot?.count;};
  function updateButton(){
    send.textContent=locked?'Повторить отправку оставшимся':snapshot?.count
      ?'Отправить '+snapshot.count+' родителям':'Нет доступных получателей';
    send.disabled=busy||!snapshot?.count;
  }
  async function preview(){
    snapshot=null;setBusy(true);audience.textContent='Проверяем список родителей…';
    feedback.textContent='';
    try{
      snapshot=await request('/lab/broadcast/preview');
      audience.textContent=snapshot.count
        ?'Сообщение появится в личных чатах родителей.'
        :'Нет получателей.';
    }catch(error){audience.textContent='Не удалось загрузить список.';feedback.textContent=error.message;}
    setBusy(false);updateButton();
  }
  function close(){
    if(busy)return;
    if(locked&&!completed&&!window.confirm('Часть сообщений могла быть отправлена. При повторной новой рассылке они могут продублироваться. Закрыть?'))return;
    overlay.classList.add('hidden');tile.focus();
  }
  tile.addEventListener('click',()=>{
    // Settings can be closed safely before the composer is shown.
    id('tutorSettingsClose')?.click();
    snapshot=null;operationId=freshId();locked=false;completed=false;
    text.value='';text.disabled=false;send.textContent='Проверяем получателей…';
    overlay.classList.remove('hidden');preview();text.focus();
  });
  closeButton.addEventListener('click',close);
  overlay.addEventListener('click',event=>{if(event.target===overlay)close()});
  overlay.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close()}});
  send.addEventListener('click',async()=>{
    const message=text.value.trim();
    if(!snapshot?.count||busy)return;
    if(!message){feedback.textContent='Введите текст сообщения.';text.focus();return}
    if(!locked&&!window.confirm('Отправить сообщение '+snapshot.count+' родителям?'))return;
    // On a partial outage preserve both the text and operation ID for deduplicated retries.
    locked=true;text.disabled=true;setBusy(true);
    feedback.textContent='Отправляем сообщения…';
    try{
      const result=await request('/lab/broadcast/send',{
        text:message,operationId,signature:snapshot.signature});
      if(result.complete){
        completed=true;
        feedback.textContent='Рассылка отправлена: '+result.count+' родителям.';
        audience.textContent='Сообщения отправлены.';
        send.textContent='Рассылка завершена';
        document.dispatchEvent(new CustomEvent('medsi:refresh-educator-chats'));
      }else{
        feedback.textContent='Не отправлено: '+result.failed+' из '+result.count+'. Нажмите «Повторить отправку оставшимся».';
      }
    }catch(error){
      feedback.textContent=error.message+' Повторите отправку.';
    }finally{setBusy(false);if(completed)send.disabled=true;else updateButton()}
  });
})();