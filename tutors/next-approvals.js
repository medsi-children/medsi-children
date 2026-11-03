(function () {
  'use strict';
  const parent=document.getElementById('medsiSettingsNext');
  const dialog=document.getElementById('tutorSettingsDialog');
  if(!parent||!dialog||document.getElementById('medsiNextApprovals'))return;
  const trigger=document.createElement('button');
  trigger.type='button';
  trigger.id='medsiNextApprovals';
  trigger.className='medsi-next-approvals-trigger';
  trigger.textContent='Заявки родителей и подтверждение доступа';
  const grid=parent.querySelector('.medsi-setting-grid');
  grid?.after(trigger);

  const overlay=document.createElement('section');
  overlay.id='medsiApprovalsOverlay';
  overlay.className='medsi-approvals-overlay hidden';
  overlay.setAttribute('role','dialog');
  overlay.setAttribute('aria-modal','true');
  overlay.setAttribute('aria-label','Заявки родителей');
  const shell=document.createElement('div');
  shell.className='medsi-approvals-shell';
  const header=document.createElement('header');
  header.className='medsi-approvals-header';
  const back=document.createElement('button');
  back.type='button';back.textContent='← Параметры';
  const heading=document.createElement('h2');heading.textContent='Заявки родителей';
  const refresh=document.createElement('button');
  refresh.type='button';refresh.textContent='Обновить';
  header.append(back,heading,refresh);
  const notice=document.createElement('p');
  notice.className='medsi-approvals-notice';
  notice.textContent='Перед подтверждением лично проверьте личность взрослого и связь с ребёнком. Телефон сам по себе подтверждением не является.';
  const status=document.createElement('p');
  status.className='medsi-approvals-status';status.setAttribute('role','status');
  const registrations=document.createElement('section');
  registrations.className='medsi-approvals-section';
  const registrationsHead=document.createElement('h3');
  registrationsHead.textContent='Новые регистрации';
  const registrationsList=document.createElement('div');
  registrations.append(registrationsHead,registrationsList);
  const recoveries=document.createElement('section');
  recoveries.className='medsi-approvals-section';
  const recoveriesHead=document.createElement('h3');
  recoveriesHead.textContent='Восстановление доступа';
  const recoveriesList=document.createElement('div');
  recoveries.append(recoveriesHead,recoveriesList);
  shell.append(header,notice,status,registrations,recoveries);
  overlay.append(shell);
  document.body.append(overlay);
  let open=false,loading=false;
  const el=(tag,text='',className='')=>{
    const node=document.createElement(tag);
    node.textContent=String(text||'');
    if(className)node.className=className;
    return node;
  };
  async function api(path,method='GET',payload=null){
    const provider=window.MedsiEducatorSession;
    if(!provider?.get)throw new Error('Воспитатель должен войти в систему.');
    const session=await provider.get();
    if(!session?.token)throw new Error('Сессия воспитателя недоступна.');
    const response=await fetch(path,{
      method,cache:'no-store',
      headers:{'X-Medsi-Chat-Session':session.token,
        ...(payload?{'content-type':'application/json'}:{})},
      ...(payload?{body:JSON.stringify(payload)}:{})
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result?.ok){
      throw new Error(result?.message||'Сервис временно недоступен.');
    }
    return result;
  }
  async function decide(path,payload) {
    status.textContent='Сохраняем решение…';
    try {
      await api(path,'POST',payload);
      await load();
    }catch(_){
      status.textContent='Решение не сохранено. Проверьте связь и повторите.';
    }
  }
  const empty=(target,message)=>{
    target.replaceChildren(el('p',message,'medsi-approvals-empty'));
  };
  function renderRegistrations(rows,candidates) {
    registrationsList.replaceChildren();
    if(!rows.length){empty(registrationsList,'Новых заявок пока нет.');return;}
    for(const item of rows) {
      const card=el('article','','medsi-approval-card');
      card.append(el('h4',item.parentName||'Родитель'),
        el('p',[item.phone||'',item.childName||''].filter(Boolean).join(' · ')));
      const select=document.createElement('select');
      select.setAttribute('aria-label','Связать с действующей госпитализацией');
      const blank=document.createElement('option');
      blank.value='';blank.textContent='Выберите ребёнка из активного списка';
      select.append(blank);
      for(const c of candidates) {
        const opt=document.createElement('option');
        opt.value=c.admissionId;
        opt.textContent=c.childName;
        select.append(opt);
      }
      const checkLabel=document.createElement('label');
      checkLabel.className='medsi-approval-confirm';
      const checked=document.createElement('input');
      checked.type='checkbox';
      checkLabel.append(checked,document.createTextNode(' Личность взрослого и право доступа проверены лично'));
      const actions=el('div','','medsi-approval-actions');
      const yes=el('button','Подтвердить','medsi-approval-yes');
      const no=el('button','Отклонить','medsi-approval-no');
      yes.type=no.type='button';
      const update=()=>{yes.disabled=!select.value||!checked.checked;};
      select.addEventListener('change',update);
      checked.addEventListener('change',update);
      update();
      yes.onclick=async()=>{
        const candidate=candidates.find(c=>c.admissionId===select.value);
        if(!candidate||!checked.checked)return;
        yes.disabled=true;no.disabled=true;
        await decide('/lab/parent-registration/decision',{
          attemptId:item.attemptId,decision:'APPROVE',
          childId:candidate.childId,admissionId:candidate.admissionId
        });
      };
      no.onclick=async()=>{
        if(!window.confirm('Отклонить эту заявку на регистрацию?'))return;
        yes.disabled=true;no.disabled=true;
        await decide('/lab/parent-registration/decision',{
          attemptId:item.attemptId,decision:'DENY'
        });
      };
      actions.append(yes,no);
      card.append(select,checkLabel,actions);
      registrationsList.append(card);
    }
  }
  function renderRecoveries(rows) {
    recoveriesList.replaceChildren();
    if(!rows.length){empty(recoveriesList,'Запросов на восстановление нет.');return;}
    for(const item of rows) {
      const card=el('article','','medsi-approval-card');
      card.append(el('h4',item.phone||'Родитель'),
        el('p','Запрос на восстановление доступа'));
      const actions=el('div','','medsi-approval-actions');
      const check=el('label','','medsi-approval-confirm');
      const cb=document.createElement('input');
      cb.type='checkbox';
      check.append(cb,document.createTextNode(' Личность и право доступа проверены лично'));
      const yes=el('button','Одобрить','medsi-approval-yes');
      const no=el('button','Отклонить','medsi-approval-no');
      yes.type=no.type='button';yes.disabled=true;
      cb.addEventListener('change',()=>{yes.disabled=!cb.checked;});
      yes.onclick=async()=>{
        yes.disabled=true;no.disabled=true;
        await decide('/lab/parent-access/decision',{requestId:item.requestId,decision:'APPROVE'});
      };
      no.onclick=async()=>{
        if(!window.confirm('Отклонить запрос на восстановление доступа?'))return;
        yes.disabled=true;no.disabled=true;
        await decide('/lab/parent-access/decision',{requestId:item.requestId,decision:'DENY'});
      };
      actions.append(yes,no);
      card.append(check,actions);
      recoveriesList.append(card);
    }
  }
  async function load() {
    if(!open||loading)return;
    loading=true;refresh.disabled=true;
    status.textContent='Загружаем заявки…';
    try {
      const [enrollment,options,access]=await Promise.all([
        api('/lab/parent-registration/pending'),
        api('/lab/parent-registration/candidates'),
        api('/lab/parent-access/requests')
      ]);
      if(!open)return;
      renderRegistrations(enrollment.registrations||[],options.children||[]);
      renderRecoveries(access.requests||[]);
      const count=(enrollment.registrations||[]).length+(access.requests||[]).length;
      status.textContent=count?'Заявок: '+count:'Всё обработано.';
    }catch(_){
      status.textContent='Не удалось получить заявки. Проверьте подключение.';
    }finally{loading=false;refresh.disabled=false;}
  }
  function close() {
    open=false;
    overlay.classList.add('hidden');
    document.body.classList.remove('medsi-approvals-open');
    document.getElementById('tutorSettingsOpen')?.click();
  }
  function show() {
    document.getElementById('tutorSettingsClose')?.click();
    open=true;
    document.body.classList.add('medsi-approvals-open');
    overlay.classList.remove('hidden');
    load();
  }
  trigger.addEventListener('click',show);
  back.addEventListener('click',close);
  refresh.addEventListener('click',load);
  overlay.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close();}
  });
})();
