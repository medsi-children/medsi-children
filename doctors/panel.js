(() => {
  'use strict';
  const id=name=>document.getElementById(name);
  const hidden=(name,value)=>id(name).classList.toggle('hidden',value);
  const node=(tag,className,text)=>{
    const element=document.createElement(tag);
    if(className)element.className=className;
    if(text)element.textContent=text;
    return element;
  };
  let screen='screenChoose';
  const titles={screenChoose:'Медси Бот',screenPhones:'Телефоны родителей',screenPatients:'Список пациентов',screenTherapy:'Психотерапия'};
  function setStatus(name,message){
    id(name).textContent=message;
    hidden(name,!message);
  }
  function show(name){
    const returningFromPatients=screen==='screenPatients' && name==='screenChoose';
    if(document.activeElement?.matches('input,textarea'))document.activeElement.blur();
    screen=name;
    Object.keys(titles).forEach(key=>hidden(key,key!==name));
    document.body.dataset.screen=name;
    id('frame').classList.toggle('choose-mode',name==='screenChoose');
    id('title').textContent=titles[name];
    id('meta').textContent=name==='screenPhones'?'Здесь можно быстро скопировать номер или позвонить.':name==='screenTherapy'?'Вставьте отчёт по групповой терапии.':'';
    hidden('meta',!id('meta').textContent);
    id('doctorWorkspace').inert=name==='screenPatients';
    if(name==='screenPatients'){
      id('screenPatients').scrollTop=0;
      id('screenPatients').focus({preventScroll:true});
    }else if(returningFromPatients){
      id('doctorPatients').focus({preventScroll:true});
    }
    window.scrollTo(0,0);
  }
  async function request(path,{body,signal}={}){
    const response=await fetch('/doctors/api'+path,{
      method:body?'POST':'GET',cache:'no-store',
      signal:signal||AbortSignal.timeout(18000),
      ...(body?{body:JSON.stringify(body),headers:{'content-type':'application/json'}}:{})
    });
    const data=await response.json().catch(()=>null);
    if(response.status===401 && !['/session','/login'].includes(path))location.reload();
    if(!response.ok || !data?.ok)
      throw Object.assign(new Error(data?.message||'Сервис временно недоступен.'),{status:response.status});
    return data;
  }
  window.MedsiDoctors={request};
  function enter(){
    hidden('tutorAuthGate',true);
    hidden('doctorWorkspace',false);
    show('screenChoose');
  }
  async function restore(){
    try{await request('/session');enter();}
    catch(error){
      if(error.status===401){hidden('authChecking',true);hidden('authForm',false);return;}
      id('authCheckingText').textContent='Панель временно недоступна.';
      hidden('authRetry',false);
      id('authChecking').querySelector('.boot-spinner').classList.add('hidden');
    }
  }
  id('authForm').onsubmit=async event=>{
    event.preventDefault();
    const button=id('tutorLoginBtn');
    if(button.disabled)return;
    const login=id('tutorLogin').value.trim(),password=id('tutorPassword').value;
    if(!login||!password){setStatus('tutorAuthError','Введите логин и пароль.');return;}
    button.disabled=true;button.textContent='Проверяем…';
    setStatus('tutorAuthError','');
    try{await request('/login',{body:{login,password}});id('tutorPassword').value='';enter();}
    catch(error){setStatus('tutorAuthError',error.message);}
    finally{button.disabled=false;button.textContent='Войти в систему';}
  };

  const launcher=document.querySelector('#medsiAssistantLogo .medsi-bot-launcher');
  const character=launcher.querySelector('.medsi-character');
  let pointerActiveUntil=0;
  function setGaze(x,y){
    const size=238;
    character.style.setProperty('--gaze-x',Math.max(-size*.055,Math.min(size*.055,x-size*.055))+'px');
    character.style.setProperty('--gaze-y',Math.max(-size*.065,Math.min(size*.055,y+size*.025))+'px');
  }
  launcher.addEventListener('pointermove',event=>{
    if(event.pointerType!=='mouse')return;
    const b=launcher.getBoundingClientRect();
    setGaze(Math.max(-23.8,Math.min(23.8,(event.clientX-b.left-b.width/2)/b.width*59.5)),
      Math.max(-19.04,Math.min(19.04,(event.clientY-b.top-b.height/2)/b.height*59.5)));
    pointerActiveUntil=Date.now()+1600;
  },{passive:true});
  if(!matchMedia('(prefers-reduced-motion: reduce)').matches)setInterval(()=>{
    if(screen==='screenChoose' && Date.now()>=pointerActiveUntil)
      setGaze(238*(.025+(Math.random()-.5)*.09),238*(-.04+(Math.random()-.5)*.07));
  },2200);
  setGaze(238*.10,238*-.08);

  const normalize=value=>String(value||'').toLocaleLowerCase('ru').replace(/ё/g,'е').trim();
  const phoneText=phone=>phone.replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/,'+7 ($1) $2-$3-$4');
  const phoneLink=phone=>{
    const link=node('a','',phoneText(phone));
    link.href='tel:'+phone;
    return link;
  };
  const dateText=date=>date ? date.split('-').reverse().join('.') : '—';
  const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const days=(a,b)=>Math.round((Date.parse(a)-Date.parse(b))/86400000);
  const plural=new Intl.PluralRules('ru');
  const countDays=count=>count+' '+({one:'день',few:'дня',many:'дней'}[plural.select(count)]||'дня');

  let patients=[],phones=[],listing=null,renderedDay='',showHidden=false;
  const parentLabel=parent=>[parent.parentName,parent.relationship].filter(Boolean).join(' · ')||'Родитель';

  function patientDate(label,value){
    const field=node('div','patient-date');
    field.append(node('span','patient-field-label',label));
    const date=node(value?'time':'span','patient-date-value',dateText(value));
    if(value)date.dateTime=value;
    else date.setAttribute('aria-label',label+': дата не указана');
    field.append(date);
    return field;
  }

  function deadlineTone(remaining){
    if(remaining===null)return 'unknown';
    if(remaining<0)return 'past';
    if(remaining===0)return 'today';
    if(remaining<=3)return 'soon';
    if(remaining<=7)return 'week';
    return 'later';
  }

  function remainingDays(patient,day){
    const remaining=patient.discharge?days(patient.discharge,day):NaN;
    return Number.isFinite(remaining)?remaining:null;
  }

  function patientDeadline(patient,day,scale){
    const footer=node('div','patient-deadline');
    const remaining=remainingDays(patient,day);
    const left=Math.max(0,remaining);
    const label=remaining===null?'Дата выписки не указана':remaining===0?'Выписка сегодня':
      (plural.select(left)==='one'?'Остался ':'Осталось ')+countDays(left);
    footer.dataset.tone=deadlineTone(remaining);
    const status=node('span','patient-deadline-label');
    status.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v4m9-4v4M3 10h11m-5 11H6a3 3 0 0 1-3-3V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3"/><circle cx="16.5" cy="16.5" r="4.5"/><path d="M16.5 14v2.5l1.5 1"/></svg>';
    status.append(document.createTextNode(label));
    footer.append(status);
    if(remaining!==null){
      const bar=node('meter');
      bar.max=scale;
      bar.value=left;
      bar.setAttribute('aria-label','Дни до выписки');
      bar.setAttribute('aria-valuetext',countDays(left));
      footer.append(bar);
    }
    return footer;
  }

  const dischargeSources={
    doctor:'Дата установлена врачом',
    disk:'Взято с Яндекс Диска',
    'disk-preliminary':'Взято с Яндекс Диска · предварительный план',
    'disk-candidate':'Взято с Яндекс Диска',
    google:'Взято из Google Таблицы · ориентировочная дата'
  };

  function patientSource(source){
    const info=node('details','patient-source');
    const toggle=node('summary','patient-icon patient-source-toggle');
    toggle.setAttribute('aria-label','Источник даты выписки');
    toggle.title='Источник даты выписки';
    toggle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 11v6m0-10h.01"/></svg>';
    info.append(toggle,node('p','patient-source-note',source));
    info.onkeydown=event=>{
      if(event.key==='Escape'&&info.open){info.open=false;toggle.focus();}
    };
    return info;
  }

  function patientRow(patient,day,scale){
    const row=node('li','medsi-roster-line patient-card');
    const name=patient.childName||'Имя ребёнка не указано';
    const identity=node('div','medsi-roster-line-info patient-info');
    const heading=node('div','patient-card-heading');
    const tools=node('div','patient-card-actions');
    heading.append(node('h3','medsi-roster-line-name',name),tools);
    identity.append(heading);
    const source=dischargeSources[patient.dischargeSource];
    if(source)tools.append(patientSource(source));
    const contacts=node('div','patient-contacts');
    for(const parent of patient.parents){
      const contact=node('div','patient-contact');
      contact.append(node('span','',parentLabel(parent)),phoneLink(parent.phone));
      contacts.append(contact);
    }
    if(patient.parents.length)identity.append(contacts);

    const dates=node('div','patient-dates');
    const discharge=patientDate('Выписка',patient.discharge);
    if(patient.editable&&!patient.hidden){
      const edit=node('button','medsi-roster-status-icon patient-edit');
      edit.type='button';
      edit.setAttribute('aria-label','Изменить дату выписки');
      edit.dataset.tooltip='Изменить дату выписки';
      edit.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/></svg>';
      edit.onclick=()=>openDateEditor(patient);
      discharge.append(edit);
    }
    dates.append(patientDate('Госпитализация',patient.admission),discharge);
    row.append(identity,dates,patientDeadline(patient,day,scale));
    const writeLabels={pending:'Дата сохранена. Обновляем планы.',conflict:'Дата сохранена только в боте.',needsReview:'Дата сохранена только в боте.',notQueued:'Дата сохранена только в боте.'};
    if(writeLabels[patient.diskWriteStatus]&&!patient.hidden)row.append(node('p','status',writeLabels[patient.diskWriteStatus]));
    if(patient.hideable){
      const visibility=node('button','patient-icon '+(patient.hidden?'patient-restore':'patient-remove'));
      visibility.type='button';
      const actionLabel=patient.hidden?'Вернуть в список':'Убрать из списка';
      visibility.title=actionLabel;
      visibility.setAttribute('aria-label',actionLabel+': '+name);
      visibility.innerHTML=patient.hidden
        ?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5m-5-5h11a4 4 0 0 1 4 4v2"/></svg>'
        :'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7m4 4v5m4-5v5"/></svg>';

      visibility.onclick=async()=>{
        if(!patient.hidden&&!window.confirm('Убрать из списка: '+name+'? Карточку можно вернуть из раздела «Убранные».'))return;
        visibility.disabled=true;
        try{
          await request('/patient-visibility',{body:{patientId:patient.id,hidden:!patient.hidden}});
          if(listing)await listing;
          patients=patients.map(item=>item.id===patient.id?{...item,hidden:!patient.hidden}:item);
          renderPatients();
          await loadPatients(true);
        }catch(error){setStatus('patientError',error.message);}
        finally{visibility.disabled=false;}
      };
      tools.append(visibility);
    }
    return row;
  }
  function openDateEditor(patient){
    const dialog=node('dialog','doctor-date-editor');
    const form=node('form');
    const label=node('label','','Дата выписки');
    const date=node('input');
    date.type='date';date.required=true;date.value=patient.discharge||'';
    date.min=patient.admission||'';
    label.append(date);
    const adjustments=node('div','doctor-tools');
    function adjust(offset){
      if(!date.value)return;
      const next=new Date(date.value+'T00:00:00Z');
      next.setUTCDate(next.getUTCDate()+offset);
      if(Number.isFinite(+next))date.value=next.toISOString().slice(0,10);
    }
    for(const offset of [-7,-1,1,7]){
      const button=node('button','btn soft-back-btn',offset>0?'+'+offset:String(offset));
      button.type='button';button.onclick=()=>adjust(offset);
      button.setAttribute('aria-label',(offset>0?'Добавить ':'Отнять ')+countDays(Math.abs(offset)));
      adjustments.append(button);
    }
    const offset=node('input');offset.type='number';offset.step='1';
    offset.placeholder='Количество дней со знаком';
    offset.setAttribute('aria-label','Произвольное количество дней со знаком');
    const apply=node('button','btn soft-back-btn','Применить');
    apply.type='button';apply.onclick=()=>{if(offset.value&&offset.checkValidity())adjust(Number(offset.value));};
    const actions=node('div','doctor-tools');
    const cancel=node('button','btn soft-back-btn','Отмена');
    const save=node('button','btn btn-teal','Сохранить');
    const error=node('p','status error hidden');error.setAttribute('role','alert');
    cancel.type='button';cancel.onclick=()=>dialog.close();
    actions.append(cancel,save);
    form.append(label,adjustments,offset,apply);
    let confirmConflict;
    if(patient.syncConflict){
      const confirmation=node('label');
      confirmConflict=node('input');
      confirmConflict.type='checkbox';confirmConflict.required=true;
      confirmation.append(confirmConflict,document.createTextNode('Проверил актуальный план и подтверждаю выбранную дату.'));
      form.append(confirmation);
    }
    form.append(error,actions);
    dialog.append(form);document.body.append(dialog);
    dialog.onclose=()=>dialog.remove();
    form.onsubmit=async event=>{
      event.preventDefault();
      if(save.disabled||!date.reportValidity())return;
      save.disabled=true;cancel.disabled=true;
      try{
        await request('/discharge',{body:{patientId:patient.id,date:date.value,revision:patient.revision,confirmConflict:confirmConflict?.checked===true}});
        dialog.close();await loadPatients();
      }catch(failure){error.textContent=failure.message;error.classList.remove('hidden');}
      finally{save.disabled=false;cancel.disabled=false;}
    };
    dialog.showModal();
  }
  function renderPatients(){
    const value=normalize(id('patientSearch').value);
    const visible=patients.filter(patient=>Boolean(patient.hidden)===showHidden);
    const hiddenCount=patients.filter(patient=>patient.hidden).length;
    const toggle=id('patientHiddenToggle');
    toggle.textContent=showHidden?'К списку пациентов':'Убранные · '+hiddenCount;
    toggle.classList.toggle('hidden',!showHidden&&!hiddenCount);
    const rows=visible.filter(patient=>normalize(patient.childName).includes(value));
    const count=rows.length;
    id('patientCount').textContent=value?'Найдено: '+count+' из '+visible.length:
      (showHidden?'Убрано из списка: ':'Пациентов в отделении: ')+count;
    const scroll=id('screenPatients').scrollTop;
    renderedDay=today();
    const scale=patients.reduce((max,patient)=>Math.max(max,remainingDays(patient,renderedDay)??0),14);
    id('patientList').replaceChildren(...rows.map(patient=>patientRow(patient,renderedDay,scale)));
    id('patientList').classList.toggle('hidden',!count);
    id('screenPatients').scrollTop=scroll;
  }
  async function loadPatients(silent=false,refresh=false){
    if(listing)return listing;
    listing=fetchPatients(silent,refresh);
    try{await listing;}finally{listing=null;}
  }
  async function fetchPatients(silent,refresh){
    if(!silent)id('patientCount').textContent='Загружаем список…';
    try{
      const next=(await request('/patients?includeHidden=1'+(refresh?'&refresh=1':''))).patients;
      next.sort((a,b)=>(a.discharge||'9999').localeCompare(b.discharge||'9999') ||
        String(a.childName||'').localeCompare(String(b.childName||''),'ru'));
      if(!silent || renderedDay!==today() || JSON.stringify(next)!==JSON.stringify(patients)){
        patients=next;renderPatients();
      }
      setStatus('patientError','');
    }catch(error){if(!silent){id('patientCount').textContent='';setStatus('patientError',error.message);}}
  }
  function renderPhones(){
    const value=normalize(id('phoneSearch').value);
    const rows=phones.flatMap(patient=>patient.parents.map(parent=>({...parent,childName:patient.childName})));
    const cards=rows.filter(row=>normalize([row.childName,row.parentName,row.phone].join(' ')).includes(value)).map((row,index)=>{
      const card=node('div','phone-card card-enter');
      card.style.animationDelay=Math.min(index*24,160)+'ms';
      const meta=node('div','phone-card-meta');
      meta.append(node('div','',[row.relationship||'Родитель',row.parentName].filter(Boolean).join(' ')),
        node('div','phone-number-strong','Телефон: '+phoneText(row.phone)));
      const actions=node('div','phone-card-actions');
      actions.append(phoneLink(row.phone));
      card.append(node('div','phone-card-title',row.childName||'Без имени ребёнка'),meta,actions);
      return card;
    });
    id('phonesList').replaceChildren(...(cards.length?cards:[node('p','','Контактов нет.')]));
  }
  id('doctorPatients').onclick=()=>{show('screenPatients');loadPatients();};
  id('refreshPatients').onclick=()=>loadPatients(false,true);
  id('patientSearch').oninput=renderPatients;
  id('patientHiddenToggle').onclick=()=>{showHidden=!showHidden;renderPatients();};
  setInterval(()=>{
    if(screen==='screenPatients')loadPatients(true);
  },30000);
  id('btnParentPhones').onclick=async()=>{
    show('screenPhones');
    const spinner=node('div','phone-mini-loader');spinner.setAttribute('aria-label','Загрузка');
    id('phonesList').replaceChildren(spinner);
    setStatus('phonesError','');
    try{phones=(await request('/phones')).patients;renderPhones();}
    catch(error){id('phonesList').textContent='';setStatus('phonesError',error.message);}
  };
  id('phoneSearch').oninput=renderPhones;
  id('btnPsychology').onclick=()=>{
    if(!id('therapyDone').classList.contains('hidden')){
      id('therapyText').value='';hidden('therapyDone',true);hidden('therapyForm',false);
    }
    show('screenTherapy');
  };
  document.querySelectorAll('[data-home]').forEach(button=>{button.onclick=()=>show('screenChoose');});
  let attempt;
  id('therapyForm').onsubmit=async event=>{
    event.preventDefault();
    const text=id('therapyText').value;
    const button=id('therapySend');
    if(!text.trim() || button.disabled)return;
    if(attempt?.text!==text)attempt={text,submissionId:'report_'+crypto.randomUUID().replace(/-/g,'')};
    button.disabled=true;button.textContent='Отправляем…';
    setStatus('therapyError','');
    try{
      const receipt=await request('/psychology',{body:attempt});
      if(!receipt.accepted || receipt.submissionId!==attempt.submissionId)throw new Error('No receipt');
      attempt=null;
      hidden('therapyForm',true);hidden('therapyDone',false);
      if(screen==='screenTherapy'){
        id('title').textContent='Готово';id('meta').textContent='Отчёт сохранён. Можно закрыть приложение.';
      }
    }catch{
      setStatus('therapyError','Сохранение не подтверждено. При повторной отправке этого текста используется тот же номер операции.');
    }finally{button.disabled=false;button.textContent='Отправить';}
  };
  id('therapyAgain').onclick=()=>{
    attempt=null;id('therapyText').value='';
    hidden('therapyDone',true);hidden('therapyForm',false);show('screenChoose');
  };
  restore();
})();
