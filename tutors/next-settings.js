(function () {
  'use strict';

  // Production educator settings. Existing full-web.js handles shared actions.
  const dialog = document.getElementById('tutorSettingsDialog');
  const settingsBody = dialog && dialog.querySelector('.tutor-settings-body');
  if (!dialog || !settingsBody || document.getElementById('medsiSettingsNext')) return;

  const icon = (paths) => '<svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const bookIcon = icon('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>');
  const bellIcon = icon('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>');
  const personIcon = icon('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-7 7-7s7 3 7 7"/>');
  const deleteIcon = icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>');

  const root = document.createElement('div');
  root.id = 'medsiSettingsNext';
  root.className = 'medsi-settings-next';
  root.innerHTML = `
    <div class="medsi-setting-grid" role="group" aria-label="Настройки воспитателей">
      <button type="button" id="medsiOpenReportLibrary" class="medsi-setting-tile medsi-tile-reports">
        <span class="medsi-tile-icon">${bookIcon}</span>
        <span class="medsi-tile-heading">Отчёты и имена</span>
        <span class="medsi-tile-sub">Общие тексты и отчёты по детям</span>
      </button>
      <button type="button" id="medsiPushCard" class="medsi-setting-tile medsi-tile-push" aria-pressed="false" disabled>
        <span class="medsi-tile-icon">${bellIcon}</span>
        <span id="medsiPushCardLabel" class="medsi-tile-heading">Проверяем уведомления…</span>
        <span class="medsi-tile-sub">На этом устройстве</span>
      </button>
      <button type="button" id="medsiParentPreviewCard" class="medsi-setting-tile medsi-tile-parent">
        <span class="medsi-tile-icon">${personIcon}</span>
        <span class="medsi-tile-heading">Родительская панель</span>
        <span class="medsi-tile-sub">Открыть глазами родителя</span>
      </button>
      <button type="button" id="medsiDeleteParentCard" class="medsi-setting-tile medsi-tile-delete">
        <span class="medsi-tile-icon">${deleteIcon}</span>
        <span class="medsi-tile-heading">Удалить ребёнка</span>
        <span class="medsi-tile-sub">Выбрать профиль для удаления</span>
      </button>
    </div>
    <p id="medsiSettingFeedback" class="medsi-setting-feedback" role="status"></p>
    <section id="medsiSettingPicker" class="medsi-setting-picker hidden" aria-label="Выбор профиля">
      <header class="medsi-setting-picker-head">
        <h3 id="medsiSettingPickerTitle">Выберите профиль</h3>
        <button id="medsiSettingPickerBack" type="button" aria-label="Назад к параметрам">×</button>
      </header>
      <div id="medsiSettingPickerList" class="medsi-setting-picker-list" role="list"></div>
    </section>`;
  settingsBody.prepend(root);
  dialog.classList.add('medsi-settings-next-enabled');

  const byId = id => document.getElementById(id);
  const pushLegacy = byId('tutorPushToggle');
  const pushCard = byId('medsiPushCard');
  const label = byId('medsiPushCardLabel');
  const feedback = byId('medsiSettingFeedback');
  const picker = byId('medsiSettingPicker');
  const pickerList = byId('medsiSettingPickerList');
  let pickerSource = null;
  let pickerAction = null;
  let pickerTitle = '';
  const chooseCard = root.querySelector('.medsi-setting-grid');

  function updatePushCard() {
    const status = byId('tutorPushStatus');
    const known = pushLegacy && ['0','1'].includes(pushLegacy.dataset.enabled);
    const enabled = known && pushLegacy.dataset.enabled === '1';
    pushCard.disabled = !known || !!pushLegacy.disabled;
    pushCard.dataset.enabled = enabled ? '1' : '0';
    pushCard.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    label.textContent = !known ? 'Проверяем уведомления…'
      : enabled ? 'Уведомления включены' : 'Уведомления отключены';
    feedback.textContent = status && status.textContent || '';
  }

  if (pushLegacy) {
    new MutationObserver(updatePushCard).observe(pushLegacy, { attributes: true, attributeFilter: ['data-enabled', 'disabled'], childList: true });
    const status = byId('tutorPushStatus');
    if (status) new MutationObserver(updatePushCard).observe(status, { childList: true, characterData: true, subtree: true });
    pushCard.addEventListener('click', () => { if (!pushCard.disabled) pushLegacy.click(); });
    updatePushCard();
  }

  function closePicker() {
    picker.classList.add('hidden');
    chooseCard.classList.remove('hidden');
    pickerSource = null;
    pickerAction = null;
  }

  function renderPicker() {
    if (!pickerSource || !pickerAction) return;
    pickerList.replaceChildren();
    const options = Array.from(pickerSource.options).filter(option => option.value !== '' && !option.disabled);
    if (!options.length) {
      const empty = document.createElement('p');
      empty.className = 'medsi-picker-empty';
      empty.textContent = 'Профили загружаются или пока отсутствуют.';
      pickerList.append(empty);
      return;
    }
    for (const option of options) {
      const index = option.value;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'medsi-picker-option';
      button.textContent = option.textContent.trim();
      button.addEventListener('click', () => {
        if (!pickerSource || !pickerAction) return;
        pickerSource.value = index;
        const action = pickerAction;
        closePicker();
        action.click(); // Existing full-web.js action: preview or confirm+deletion queue.
      });
      pickerList.appendChild(button);
    }
  }

  function openPicker(title, sourceId, actionId) {
    const source = byId(sourceId), action = byId(actionId);
    if (!source || !action) return;
    pickerSource = source;
    pickerAction = action;
    pickerTitle = title;
    byId('medsiSettingPickerTitle').textContent = pickerTitle;
    feedback.textContent = '';
    chooseCard.classList.add('hidden');
    picker.classList.remove('hidden');
    renderPicker();
    // Full-web.js refreshes the hidden legacy selects asynchronously.
  }
  byId('medsiParentPreviewCard').addEventListener('click', () =>
    openPicker('Родительская панель', 'previewChildSelect', 'previewParentButton'));
  byId('medsiDeleteParentCard').addEventListener('click', () => openPicker('Удалить ребёнка', 'deleteChildSelect', 'settingsDeleteChild'));
  byId('medsiSettingPickerBack').addEventListener('click', closePicker);
  for (const id of ['previewChildSelect', 'deleteChildSelect']) {
    const select = byId(id);
    if (select) new MutationObserver(() => { if (pickerSource === select) renderPicker(); })
      .observe(select, { childList: true, subtree: true });
  }
  const oldOpen = byId('tutorSettingsOpen');
  if (oldOpen) oldOpen.addEventListener('click', () => { closePicker(); updatePushCard(); });
  const oldClose = byId('tutorSettingsClose');
  if (oldClose) oldClose.addEventListener('click', closePicker);

  const library = document.createElement('section');
  library.id = 'medsiTutorReportLibrary';
  library.className = 'medsi-tutor-reports hidden';
  library.setAttribute('role', 'dialog');
  library.setAttribute('aria-modal', 'true');
  library.setAttribute('aria-labelledby', 'medsiReportsTitle');
  library.innerHTML = `
    <div class="medsi-reports-shell">
      <header class="medsi-reports-header">
        <button type="button" id="medsiReportsBack" class="medsi-reports-back">← <span>Параметры</span></button>
        <h2 id="medsiReportsTitle">Отчёты и имена</h2>
        <button type="button" id="medsiReportsRefresh" class="medsi-reports-refresh" aria-label="Обновить отчёты">↻</button>
      </header>
      <div class="medsi-reports-switch" role="tablist" aria-label="Тип отчётов">
        <button type="button" id="medsiTabRaw" role="tab" aria-selected="true" aria-controls="medsiRawPane"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg><span>Исходные отчёты</span></button>
        <button type="button" id="medsiTabChildren" role="tab" aria-selected="false" aria-controls="medsiChildrenPane"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M2.5 20v-2a6.5 6.5 0 0 1 13 0v2"/><circle cx="17" cy="9" r="2.5"/><path d="M18 14a5 5 0 0 1 3.5 4.8V20"/></svg><span>Отчёты по детям</span></button>
        <button type="button" id="medsiTabNames" role="tab" aria-selected="false" aria-controls="medsiNamesPane"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11V5a2 2 0 0 1 2-2h6l10 10-8 8L3 11Z"/><circle cx="8" cy="8" r="1"/></svg><span>Варианты имён</span></button>
        <button type="button" id="medsiTabRoster" role="tab" aria-selected="false" aria-controls="medsiRosterPane"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M5.5 17c0-2 1.5-3.2 3.5-3.2s3.5 1.2 3.5 3.2M15 9h3M15 13h3"/></svg><span>Дети и родители</span></button>
      </div>
      <p id="medsiReportsFeedback" class="medsi-reports-feedback" role="status"></p>
      <div id="medsiRawPane" role="tabpanel" aria-labelledby="medsiTabRaw" class="medsi-reports-content"></div>
      <div id="medsiChildrenPane" role="tabpanel" aria-labelledby="medsiTabChildren" class="medsi-reports-content hidden"></div>
      <div id="medsiNamesPane" role="tabpanel" aria-labelledby="medsiTabNames" class="medsi-reports-content hidden"></div>
        <div id="medsiRosterPane" role="tabpanel" aria-labelledby="medsiTabRoster" class="medsi-reports-content hidden"></div>
    </div>`;
  document.body.append(library);

  let opened = false;
  let activeTab = 'raw';
  let reportData = null;
  let refreshController = null;

  function formatDisplayDate(value) {
    const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!match)return String(value||'');
    const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
    return Number.isNaN(date.getTime())?String(value||''):
      date.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
  }
  function reportTypeLabel(type) { return type==='morning'?'Утренний отчёт':type==='evening'?'Вечерний отчёт':'Психотерапия'; }
  function textNode(tag,className,value){const el=document.createElement(tag);el.className=className||'';el.textContent=String(value??'');return el;}
  const reportText=value=>String(value||'').trim()||'Отчёта пока нет.';
  async function request(path,method='GET',body){
    const session=await MedsiEducatorSession.get();
    const response=await fetch(path,{method,headers:{'Content-Type':'application/json','X-Medsi-Chat-Session':session.token},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});
    // A gateway may return an empty or non-JSON body after a failed request.
    // Do not expose the browser's JSON.parse exception or assume a write failed.
    const responseText=await response.text();
    let data=null;
    if(responseText.trim()){
      try{data=JSON.parse(responseText);}catch(_){/* Upstream returned non-JSON. */}
    }
    if(!data||typeof data!=='object'){
      const status=response.status?(' (HTTP '+response.status+')'):'';
      throw new Error('Сервер не прислал корректное подтверждение'+status+'. Проверьте, сохранились ли изменения, прежде чем повторять действие.');
    }
    if(!response.ok||!data.ok)throw new Error(data.message||'Не удалось сохранить изменения.');
    return data;
  }
  function inlineReport(value,label,save){
    const wrap=textNode('div','medsi-inline-report','');
    function display(){
      const body=textNode('div','medsi-report-body medsi-report-clickable',reportText(value));body.tabIndex=0;body.setAttribute('role','button');body.setAttribute('aria-label','Редактировать: '+label);
      const open=()=>{
        const form=document.createElement('form');form.className='medsi-inline-form';
        const area=document.createElement('textarea');area.value=value||'';area.maxLength=240000;area.setAttribute('aria-label',label);
        const actions=textNode('div','medsi-inline-actions','');
        const submit=textNode('button','medsi-inline-save','✓ Сохранить');submit.type='submit';
        const cancel=textNode('button','medsi-inline-cancel','Отмена');cancel.type='button';cancel.onclick=display;
        actions.append(submit,cancel);form.append(area,actions);wrap.replaceChildren(form);area.style.height=Math.min(600,Math.max(140,area.scrollHeight+4))+'px';area.focus({preventScroll:true});
        form.onsubmit=async event=>{event.preventDefault();if(area.value===String(value||'')){display();return;}submit.disabled=true;cancel.disabled=true;
          try{await save(area.value);value=area.value;display();await refreshLibrary();}catch(error){byId('medsiReportsFeedback').textContent=error.message||'Не удалось сохранить. Повторите попытку.';submit.disabled=false;cancel.disabled=false;}
        };
      };
      body.onclick=open;body.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}};wrap.replaceChildren(body);
    }
    display();return wrap;
  }
  let namesDraft=[],namesOriginal='',namesRevision='',namesLoaded=false,pendingNameEdit=null,namesSaving=false;
  const namesSignature=()=>JSON.stringify(namesDraft.map(r=>[r.baseKey,r.preferredName,r.variants]));
  const namesDirty=()=>namesLoaded&&(namesSignature()!==namesOriginal||!!(pendingNameEdit&&pendingNameEdit.input.value.trim()!==pendingNameEdit.original));
  const key=value=>String(value||'').trim().toLocaleLowerCase('ru').replace(/ё/g,'е');
  function validWord(value){const word=String(value||'').trim().normalize('NFC');if(!/^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$/u.test(word)||word.length>80)throw new Error('Введите одно русское имя.');return word;}
  function updateSaveState(){const save=byId('medsiNamesSave');if(save)save.disabled=namesSaving||!namesDirty();}
  async function leaveNames(){
    if(!namesDirty())return true;
    return new Promise(resolve=>{
      const prompt=document.createElement('dialog');prompt.className='medsi-name-dialog medsi-leave-dialog';
      prompt.append(textNode('h3','','Сохранить изменения?'),textNode('p','','В списке имён есть несохранённые изменения.'));
      const actions=textNode('div','medsi-dialog-actions','');
      for(const [label,action] of [['Сохранить','save'],['Не сохранять','discard'],['Остаться','cancel']]){
        const button=textNode('button',action==='save'?'medsi-inline-save':'medsi-inline-cancel',label);button.type='button';
        button.onclick=async()=>{if(action==='save'){button.disabled=true;if(!await saveNames()){button.disabled=false;return;}}if(action==='discard'){namesLoaded=false;pendingNameEdit=null;}prompt.close();prompt.remove();resolve(action!=='cancel');};actions.append(button);
      }
      prompt.append(actions);prompt.addEventListener('cancel',e=>{e.preventDefault();prompt.remove();resolve(false);});document.body.append(prompt);prompt.showModal();
    });
  }
  async function showTab(kind){
    if(activeTab==='names'&&kind!=='names'&&!await leaveNames())return;
    activeTab=kind;
    for(const [name,id,pane] of [['raw','medsiTabRaw','medsiRawPane'],['children','medsiTabChildren','medsiChildrenPane'],['names','medsiTabNames','medsiNamesPane'],['roster','medsiTabRoster','medsiRosterPane']]){
      byId(id).setAttribute('aria-selected',String(kind===name));byId(pane).classList.toggle('hidden',kind!==name);
    }
    if(kind==='names')await refreshNames();
    if(kind==='roster')await refreshRoster();
  }
  byId('medsiTabRaw').addEventListener('click',()=>showTab('raw'));
  byId('medsiTabChildren').addEventListener('click',()=>showTab('children'));
  byId('medsiTabNames').addEventListener('click',()=>showTab('names'));
  byId('medsiTabRoster').addEventListener('click',()=>showTab('roster'));
  function renderRaw(data){
    const root=byId('medsiRawPane');root.replaceChildren();
    for(const kind of ['morning','evening','psychology']){
      const entry=data.raw?.[kind]||{},card=textNode('article','medsi-raw-report medsi-raw-'+kind,'');
      const header=textNode('header','medsi-raw-header',''),heading=textNode('div','medsi-raw-heading','');
      const sym=textNode('span','medsi-raw-symbol','');
      sym.innerHTML=kind==='morning'?icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'):
        kind==='evening'?icon('<path d="M20.5 15.5A9 9 0 0 1 8.5 3.5a9 9 0 1 0 12 12Z"/><path d="M17 3v4M15 5h4"/>'):
        icon('<path d="M12 5a4 4 0 0 0-7 3 4 4 0 0 0 0 8 4 4 0 0 0 7 3"/><path d="M12 5a4 4 0 0 1 7 3 4 4 0 0 1 0 8 4 4 0 0 1-7 3M12 5v14"/>');
      heading.append(textNode('h3','',reportTypeLabel(kind)),textNode('p','medsi-report-date',entry.reportDate?formatDisplayDate(entry.reportDate):'Публикации пока нет'));
      header.append(sym,heading);
      if(entry.publicationId){
        const copy=textNode('button','medsi-report-copy','');
        copy.type='button';copy.setAttribute('aria-label','Скопировать '+reportTypeLabel(kind).toLowerCase());copy.title='Скопировать отчёт';
        copy.innerHTML=icon('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>');
        copy.onclick=async()=>{try{await navigator.clipboard.writeText(String(entry.rawText||''));byId('medsiReportsFeedback').textContent='Отчёт скопирован.';}catch(_){byId('medsiReportsFeedback').textContent='Не удалось скопировать. Проверьте разрешение браузера.';}};
        header.append(copy);
      }
      card.append(header);
      const wave=document.createElementNS('http://www.w3.org/2000/svg','svg');
      wave.setAttribute('viewBox','0 0 300 96');wave.setAttribute('preserveAspectRatio','none');wave.setAttribute('aria-hidden','true');wave.setAttribute('class','medsi-raw-wave');
      wave.innerHTML='<path d="M55 0h245v70C204 25 146 105 55 0Z"/><path d="M130 0h170v48C250 0 218 68 130 0Z"/>';
      card.append(wave);
      if(entry.publicationId){
        card.classList.add('medsi-raw-collapsed');
        card.append(inlineReport(entry.rawText,reportTypeLabel(kind),text=>request('/lab/admin/reports/raw','POST',{kind,text,publicationId:entry.publicationId,submissionId:entry.pendingSubmissionId||(entry.pendingSubmissionId=crypto.randomUUID())})));
        const toggle=textNode('button','medsi-raw-expand','');
        toggle.type='button';toggle.setAttribute('aria-label','Развернуть отчёт');toggle.setAttribute('aria-expanded','false');
        toggle.onclick=()=>{const open=card.classList.toggle('medsi-raw-expanded');toggle.setAttribute('aria-label',open?'Свернуть отчёт':'Развернуть отчёт');toggle.setAttribute('aria-expanded',String(open));};
        card.append(toggle);
      }else card.append(textNode('div','medsi-report-body','Отчёта пока нет.'));
      root.append(card);
    }
  }
  let childPageIndex=0;
  function renderChildren(data){
    const pane=byId('medsiChildrenPane');pane.replaceChildren();
    const children=Array.isArray(data.children)?data.children:[];
    if(!children.length){pane.append(textNode('p','medsi-reports-empty','В базе пока нет активных детей.'));return;}
    childPageIndex=Math.max(0,Math.min(childPageIndex,children.length-1));
    const child=children[childPageIndex];
    const navigation=textNode('section','medsi-child-deck-nav','');
    const previous=textNode('button','medsi-child-nav-arrow',''),next=textNode('button','medsi-child-nav-arrow','');
    for(const button of [previous,next]){button.type='button';button.innerHTML=icon('<path d="M19 12H5M12 19l-7-7 7-7"/>');}
    next.classList.add('medsi-child-nav-next');
    previous.setAttribute('aria-label','Предыдущий ребёнок');next.setAttribute('aria-label','Следующий ребёнок');
    previous.disabled=childPageIndex===0;next.disabled=childPageIndex===children.length-1;
    previous.onclick=()=>{childPageIndex=Math.max(0,childPageIndex-1);renderChildren(data);};
    next.onclick=()=>{childPageIndex=Math.min(children.length-1,childPageIndex+1);renderChildren(data);};
    const identity=textNode('div','medsi-child-deck-identity','');
    const names=textNode('div','medsi-child-deck-name','');
    names.append(textNode('h3','',child.childName||'Без имени'),textNode('p','',child.surname||''));
    identity.append(names);
    const details=textNode('div','medsi-child-deck-details','');
    for(const parent of child.parents||[]){
      const parentLine=textNode('p','',[(parent.relationship||'Родитель')+':',parent.parentName||'—',parent.phone||''].filter(Boolean).join(' '));
      details.append(parentLine);
    }
    if(!details.children.length)details.append(textNode('p','','Родитель не привязан'));
    identity.append(details);
    navigation.append(previous,identity,next);
    pane.append(navigation);
    pane.append(textNode('p','medsi-child-deck-progress',(childPageIndex+1)+' / '+children.length));
    const views=Array.isArray(child.parentViews)?child.parentViews:[];
    for(const view of views){
      const block=textNode('article','medsi-child-deck-reports','');
      if(views.length>1)block.append(textNode('h4','medsi-view-parent',view.parentName||view.phone||'Родитель'));
      for(const kind of ['morning','evening']){
        const current=view.reports?.[kind]||'';
        const section=textNode('section','medsi-child-report-section medsi-child-report-section-'+kind,'');
        section.append(textNode('h5','',reportTypeLabel(kind)));
        section.append(inlineReport(current,reportTypeLabel(kind),text=>request('/lab/admin/reports/edit','POST',{
          phone10:view.phone10,admissionId:child.admissionId,kind,text,expectedText:current
        })));
        block.append(section);
      }
      pane.append(block);
    }
    if(!views.length)pane.append(textNode('p','medsi-reports-empty','Для ребёнка пока нет распределённых отчётов.'));
  }
  let rosterData=null;
  function rosterEdit(fields,onSave){
    const form=textNode('form','medsi-roster-form','');
    const inputs={};
    for(const field of fields){
      const label=textNode('label','',field.label),input=document.createElement('input');
      input.type='text';input.value=field.value;input.maxLength=130;input.required=true;label.append(input);form.append(label);inputs[field.id]=input;
    }
    const buttons=textNode('div','medsi-roster-actions',''),save=textNode('button','medsi-inline-save','Сохранить'),
      cancel=textNode('button','medsi-inline-cancel','Отмена');
    save.type='submit';cancel.type='button';
    cancel.onclick=()=>renderRoster(rosterData);
    buttons.append(cancel,save);form.append(buttons);
    form.onsubmit=async event=>{
      event.preventDefault();save.disabled=true;cancel.disabled=true;
      try{
        await onSave(Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value.trim()])));
        await refreshRoster();refreshLibrary();
        byId('medsiReportsFeedback').textContent='Данные сохранены.';
      }catch(error){
        byId('medsiReportsFeedback').textContent=error.message||'Не удалось сохранить.';
        save.disabled=false;cancel.disabled=false;
      }
    };
    return form;
  }
  function renderRoster(data){
    const pane=byId('medsiRosterPane');pane.replaceChildren();
    const children=Array.isArray(data?.children)?data.children:[];
    if(!children.length){pane.append(textNode('p','medsi-reports-empty','В отделении пока нет активных детей.'));return;}
    for(const child of children){
      const parents=Array.isArray(child.parents)?child.parents:[];
      const card=textNode('article','medsi-roster-line',''),info=textNode('div','medsi-roster-line-info','');
      const name=textNode('button','medsi-roster-line-name',[child.firstName,child.surname].filter(Boolean).join(' ')||'Без имени');
      name.type='button';name.title='Изменить имя ребёнка';name.onclick=()=>info.replaceChildren(rosterEdit([
        {id:'firstName',label:'Имя ребёнка',value:child.firstName},
        {id:'surname',label:'Фамилия ребёнка',value:child.surname}
      ],values=>request('/lab/admin/roster/edit','POST',{
        kind:'child',childId:child.childId,admissionId:child.admissionId,
        ...values,expectedFirstName:child.firstName,expectedSurname:child.surname
      })));
      info.append(name);
      const parentText=textNode('div','medsi-roster-line-parent','');
      for(const parent of parents){
        const parentButton=textNode('button','',[(parent.relationship||'Родитель'),parent.parentName||'—'].join(' '));
        parentButton.type='button';parentButton.title='Изменить данные родителя';
        parentButton.onclick=()=>info.replaceChildren(rosterEdit([
          {id:'parentName',label:'Имя родителя',value:parent.parentName},
          {id:'relationship',label:'Кем приходится ребёнку',value:parent.relationship||'Родитель'}
        ],values=>request('/lab/admin/roster/edit','POST',{
          kind:'parent',phone10:parent.phone10,childId:child.childId,admissionId:child.admissionId,
          ...values,expectedParentName:parent.parentName,expectedRelationship:parent.relationship
        })));
        parentText.append(parentButton);
      }
      if(!parents.length)parentText.textContent='Родитель не привязан';
      info.append(parentText);
      const actions=textNode('div','medsi-roster-line-actions','');
      for(const [kind,label,present] of [['morning','Утренний',child.morning],['evening','Вечерний',child.evening]]){
        const button=textNode('button','medsi-roster-status-icon medsi-roster-status-'+kind,'');
        button.type='button';button.dataset.present=present?'1':'0';
        button.setAttribute('aria-label',label+(present?' отчёт есть':' отчёта нет'));
        button.title=label+(present?' отчёт есть':' отчёта нет');
        button.innerHTML=kind==='morning'?icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'):
          icon('<path d="M20.5 15.5A9 9 0 0 1 8.5 3.5a9 9 0 1 0 12 12Z"/>');
        button.onclick=()=>{byId('medsiReportsFeedback').textContent=button.getAttribute('aria-label');};
        actions.append(button);
      }
      const del=textNode('button','medsi-roster-line-delete','');
      del.type='button';del.setAttribute('aria-label','Удалить профиль');del.title='Удалить профиль родителя';
      del.innerHTML=deleteIcon;
      del.onclick=async()=>{
        if(!parents.length){byId('medsiReportsFeedback').textContent='У ребёнка нет профиля родителя для удаления.';return;}
        let parent=parents[0];
        if(parents.length>1){
          const choice=window.prompt('Выберите номер родителя для удаления:\n'+parents.map((p,i)=>(i+1)+'. '+(p.parentName||'Родитель')).join('\n'));
          if(choice===null)return;
          const index=Number(choice)-1;
          if(!Number.isInteger(index)||index<0||index>=parents.length){byId('medsiReportsFeedback').textContent='Неверный номер родителя.';return;}
          parent=parents[index];
        }
        const label=[parent.parentName,child.firstName,child.surname].filter(Boolean).join(' / ');
        if(!window.confirm('Удалить профиль '+label+'?\n\nБудут удалены переписка и доступ выбранного родителя. Другие родители ребёнка сохранятся.'))return;
        del.disabled=true;
        try{
          const uuid=window.crypto&&typeof window.crypto.randomUUID==='function'?window.crypto.randomUUID().replace(/-/g,''):Date.now().toString(36)+Math.random().toString(36).slice(2);
          const answer=await request('/lab/parent-delete','POST',{phone:parent.phone,operationId:'del_'+uuid});
          if(answer.accepted!==true)throw new Error(answer.message||'Удаление не принято сервером.');
          await refreshRoster();refreshLibrary();
          byId('medsiReportsFeedback').textContent='Удаление профиля принято в обработку.';
        }catch(error){del.disabled=false;byId('medsiReportsFeedback').textContent=error.message||'Не удалось удалить профиль.';}
      };
      actions.append(del);
      card.append(info,actions);pane.append(card);
    }
  }
  async function refreshRoster(){
    try{rosterData=await request('/lab/admin/roster');if(activeTab==='roster')renderRoster(rosterData);}
    catch(error){byId('medsiReportsFeedback').textContent=error.message||'Не удалось загрузить список детей и родителей.';}
  }
  function nameToken(row,name,canonical){
    const token=textNode('span','medsi-name-token'+(canonical?' medsi-name-canonical':''),'');token.dataset.tone=String(Math.max(0,row.variants.indexOf(name)-1)%4);
    const button=textNode('button','medsi-name-word',name);button.type='button';
    button.onclick=()=>{
      if(pendingNameEdit&&!pendingNameEdit.commit(false))return;
      const input=document.createElement('input');input.value=name;input.maxLength=80;input.setAttribute('aria-label',canonical?'Каноничное имя':'Вариант имени');
      const tools=textNode('span','medsi-token-actions','');
      const accept=textNode('button','medsi-token-accept','✓');accept.type='button';accept.setAttribute('aria-label','Подтвердить имя');
      const remove=textNode('button','medsi-token-remove','');remove.type='button';remove.innerHTML=deleteIcon;remove.setAttribute('aria-label',canonical?'Удалить группу '+name:'Удалить вариант '+name);
      const commit=(repaint=true)=>{try{const value=validWord(input.value);if(canonical){row.variants=row.variants.filter(v=>key(v)!==key(row.preferredName));row.preferredName=value;}else row.variants=row.variants.map(v=>key(v)===key(name)?value:v);row.variants=[...new Set([row.preferredName,...row.variants])];pendingNameEdit=null;if(repaint)renderNames();else{name=value;button.textContent=value;token.replaceChildren(button);updateSaveState();}return true;}catch(error){byId('medsiReportsFeedback').textContent=error.message;input.focus();return false;}};
      accept.onclick=commit;remove.onclick=()=>{if(canonical)namesDraft=namesDraft.filter(r=>r!==row);else row.variants=row.variants.filter(v=>key(v)!==key(name));pendingNameEdit=null;renderNames();};
      input.oninput=updateSaveState;input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commit();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();pendingNameEdit=null;renderNames();}};
      tools.append(remove,accept);token.replaceChildren(input,tools);pendingNameEdit={input,original:name,commit};input.focus();input.select();
    };token.append(button);return token;
  }
  function addNamesDialog(existing){
    if(pendingNameEdit&&!pendingNameEdit.commit(false))return;
    const modal=document.createElement('dialog');modal.className='medsi-name-dialog';
    const form=document.createElement('form');modal.append(textNode('h3','',existing?'Добавить варианты':'Добавить имя'));
    const fields=textNode('div','medsi-name-dialog-fields',''),left=textNode('label','','Каноничное имя'),right=textNode('label','','Варианты');
    const canonical=document.createElement('input');canonical.required=true;canonical.placeholder='Например, Михаил';canonical.value=existing?.preferredName||'';canonical.readOnly=!!existing;
    const variants=document.createElement('textarea');variants.placeholder='Миша, Мишенька';variants.rows=3;left.append(canonical);right.append(variants);fields.append(left,right);
    const actions=textNode('div','medsi-dialog-actions',''),cancel=textNode('button','medsi-inline-cancel','Отмена'),save=textNode('button','medsi-inline-save','Добавить');cancel.type='button';cancel.onclick=()=>{modal.close();modal.remove();};save.type='submit';actions.append(cancel,save);
    const error=textNode('p','medsi-reports-feedback','');form.append(fields,error,actions);modal.append(form);document.body.append(modal);modal.showModal();(existing?variants:canonical).focus();
    modal.addEventListener('close',()=>modal.remove(),{once:true});
    form.onsubmit=e=>{e.preventDefault();try{
      const preferred=validWord(canonical.value),values=variants.value.split(/[,;\n]/).map(v=>v.trim()).filter(Boolean).map(validWord);
      const row=existing||namesDraft.find(r=>key(r.preferredName)===key(preferred));
      if(row)row.variants=[...new Set([row.preferredName,...row.variants,...values])];else namesDraft.push({baseKey:'',preferredName:preferred,variants:[preferred,...values]});
      modal.close();renderNames();
    }catch(e){error.textContent=e.message;}};
  }
  function renderNames(){
    const pane=byId('medsiNamesPane');pane.replaceChildren();
    const toolbar=textNode('div','medsi-names-toolbar',''),labels=textNode('div','medsi-name-columns','');labels.append(textNode('span','','Каноничное имя'),textNode('span','','Варианты'));
    const add=textNode('button','medsi-name-plus medsi-name-plus-main','+');add.type='button';add.setAttribute('aria-label','Добавить имя');add.onclick=()=>addNamesDialog();toolbar.append(labels,add);pane.append(toolbar);
    for(const row of [...namesDraft].sort((a,b)=>a.preferredName.localeCompare(b.preferredName,'ru'))){
      const line=textNode('div','medsi-name-row',''),canonical=textNode('div','medsi-name-left',''),variants=textNode('div','medsi-name-right','');canonical.append(nameToken(row,row.preferredName,true));
      for(const word of row.variants.filter(v=>key(v)!==key(row.preferredName)))variants.append(nameToken(row,word,false));
      const plus=textNode('button','medsi-name-plus','+');plus.type='button';plus.setAttribute('aria-label','Добавить варианты к имени '+row.preferredName);plus.onclick=()=>addNamesDialog(row);variants.append(plus);line.append(canonical,variants);pane.append(line);
    }
    const footer=textNode('div','medsi-names-footer',''),save=textNode('button','medsi-inline-save','Сохранить');save.id='medsiNamesSave';save.type='button';save.onclick=saveNames;footer.append(save);pane.append(footer);updateSaveState();
  }
  async function refreshNames(){
    if(namesLoaded){renderNames();return;}
    try{const data=await request('/lab/admin/name-variants');namesDraft=data.items.map(r=>({baseKey:r.baseKey,preferredName:r.preferredName,variants:[...r.variants]}));namesRevision=data.revision;namesLoaded=true;namesOriginal=namesSignature();renderNames();}
    catch(_){byId('medsiReportsFeedback').textContent='Не удалось загрузить варианты имён. Повторите обновление.';}
  }
  async function saveNames(){
    if(pendingNameEdit&&!pendingNameEdit.commit())return false;
    if(!namesDirty())return true;
    namesSaving=true;updateSaveState();
    try{await request('/lab/admin/name-variants','PUT',{revision:namesRevision,items:namesDraft.map(r=>({previousBaseKey:r.baseKey,preferredName:r.preferredName,variants:r.variants}))});namesLoaded=false;await refreshNames();byId('medsiReportsFeedback').textContent='Изменения сохранены.';return true;}
    catch(error){byId('medsiReportsFeedback').textContent=error.message||'Не удалось сохранить. Изменения остаются на экране.';return false;}
    finally{namesSaving=false;updateSaveState();}
  }
  window.addEventListener('beforeunload',event=>{if(namesDirty()){event.preventDefault();event.returnValue='';}});

  async function refreshLibrary() {
    if (!opened) return;
    if (refreshController) refreshController.abort();
    const controller = new AbortController();
    refreshController = controller;
    const feedback = byId('medsiReportsFeedback');
    feedback.textContent = 'Загружаем отчёты…';
    try {
      if (!window.MedsiEducatorSession) throw new Error('Сессия воспитателя недоступна.');
      const session = await MedsiEducatorSession.get();
      if (!session || !session.token) throw new Error('Требуется вход воспитателя.');
      const response = await fetch('/lab/admin/reports/dashboard', {
        headers: { 'X-Medsi-Chat-Session': session.token },
        cache: 'no-store', signal: controller.signal
      });
      const raw = await response.text();
      let data = null;
      if (raw.trim()) {
        try { data = JSON.parse(raw); } catch (_) { /* Unexpected response format. */ }
      }
      if (!response.ok || !data || data.ok !== true) {
        const detail = data && typeof data.message === 'string' ? data.message : '';
        const status = 'HTTP ' + response.status;
        const cause = !raw.trim() ? 'Пустой ответ сервера' :
          !data ? 'Ответ сервера не в формате JSON' :
          'Сервер отклонил запрос';
        throw new Error(detail || (cause + ' (' + status + ').'));
      }
      if (!opened || refreshController !== controller) return;
      reportData = data;
      renderRaw(data);
      renderChildren(data);
      feedback.textContent = '';
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!opened) return;
      console.warn('MEDSI_REPORT_DASHBOARD_LOAD_FAILED', {message:String(error?.message||'Unknown'),endpoint:'/lab/admin/reports/dashboard'});
      feedback.textContent = 'Не удалось загрузить исходные отчёты: '+String(error?.message||'Ошибка соединения')+' Попробуйте обновить раздел.';
    } finally {
      if (refreshController === controller) refreshController = null;
    }
  }

  function openLibrary() {
    byId('tutorSettingsClose').click();
    opened = true;
    document.body.classList.add('medsi-report-library-open');
    library.classList.remove('hidden');
    showTab(activeTab);
    refreshLibrary();
  }
  async function closeLibrary() {
    if(!await leaveNames())return;
    opened = false;
    document.body.classList.remove('medsi-report-library-open');
    library.classList.add('hidden');
    if (refreshController) { refreshController.abort(); refreshController = null; }
    // Return to the settings cards, preserving the original parent menu.
    byId('tutorSettingsOpen').click();
  }
  byId('medsiOpenReportLibrary').addEventListener('click', openLibrary);
  byId('medsiReportsBack').addEventListener('click', closeLibrary);
  byId('medsiReportsRefresh').addEventListener('click', async()=>{if(!await leaveNames())return;namesLoaded=false;if(activeTab==='names')await refreshNames();if(activeTab==='roster')await refreshRoster();await refreshLibrary();});
  library.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeLibrary(); }
  });
})();
