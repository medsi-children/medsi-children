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
  byId('medsiDeleteParentCard').addEventListener('click', () =>
    openPicker('Удалить ребёнка', 'deleteChildSelect', 'settingsDeleteChild'));
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
        <button type="button" id="medsiTabRaw" role="tab" aria-selected="true" aria-controls="medsiRawPane">Исходные отчёты</button>
        <button type="button" id="medsiTabChildren" role="tab" aria-selected="false" aria-controls="medsiChildrenPane">Отчёты по детям</button>
        <button type="button" id="medsiTabNames" role="tab" aria-selected="false" aria-controls="medsiNamesPane">Варианты имён</button>
        <button type="button" id="medsiTabRoster" role="tab" aria-selected="false" aria-controls="medsiRosterPane">Дети и родители</button>
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
      card.append(textNode('h3','',reportTypeLabel(kind)),textNode('p','medsi-report-date',entry.reportDate?'Дата: '+entry.reportDate:'Публикации пока нет'));
      if(entry.publicationId){
        card.classList.add('medsi-raw-collapsed');
        card.append(inlineReport(entry.rawText,reportTypeLabel(kind),text=>request('/lab/admin/reports/raw','POST',{kind,text,publicationId:entry.publicationId,submissionId:entry.pendingSubmissionId||(entry.pendingSubmissionId=crypto.randomUUID())})));
        const toggle=textNode('button','medsi-raw-expand','');
        toggle.type='button';toggle.setAttribute('aria-label','Развернуть отчёт');toggle.setAttribute('aria-expanded','false');
        toggle.onclick=()=>{const open=card.classList.toggle('medsi-raw-expanded');toggle.setAttribute('aria-label',open?'Свернуть отчёт':'Развернуть отчёт');toggle.setAttribute('aria-expanded',String(open));};
        card.append(toggle);
      }
      else card.append(textNode('div','medsi-report-body','Отчёта пока нет.'));
      root.append(card);
    }
  }
  function renderChildren(data){
    const root=byId('medsiChildrenPane');root.replaceChildren();const children=Array.isArray(data.children)?data.children:[];
    if(!children.length){root.append(textNode('p','medsi-reports-empty','В базе пока нет активных детей.'));return;}
    for(const child of children){
      const card=textNode('article','medsi-child-report-card',''),left=textNode('div','medsi-child-details',''),right=textNode('div','medsi-child-report-view','');
      left.append(textNode('h3','medsi-child-name',child.childName||'Без имени'),textNode('p','medsi-child-meta',child.surname||''));
      for(const parent of child.parents||[]){const line=textNode('div','medsi-child-parent','');line.append(textNode('div','medsi-parent-name',[parent.relationship||'Родитель',parent.parentName||'—'].join(' · ')),textNode('div','medsi-parent-phone',parent.phone||''));left.append(line);}
      const views=child.parentViews||[];
      for(const view of views){
        const block=textNode('div','medsi-child-report-version','');if(views.length>1)block.append(textNode('div','medsi-view-parent',view.parentName||view.phone||'Родитель'));
        for(const kind of ['morning','evening']){const current=view.reports?.[kind]||'',section=textNode('section','medsi-child-report-section medsi-child-report-section-'+kind,'');section.append(textNode('h5','',reportTypeLabel(kind)),inlineReport(current,reportTypeLabel(kind),text=>request('/lab/admin/reports/edit','POST',{phone10:view.phone10,admissionId:child.admissionId,kind,text,expectedText:current})));block.append(section);}right.append(block);
      }
      card.append(left,right);root.append(card);
    }
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
    const counts=data?.counts||{};
    pane.append(textNode('p','medsi-roster-overview',
      'Сейчас в отделении: '+(counts.activeChildren||0)+' детей · '+(counts.activeParentProfiles||0)+' профилей родителей'));
    
    const children=Array.isArray(data?.children)?data.children:[];
    if(!children.length)pane.append(textNode('p','medsi-reports-empty','Активных госпитализаций пока нет.'));
    for(const child of children){
      const card=textNode('article','medsi-roster-card','');
      const head=textNode('div','medsi-roster-head',''),titleBox=textNode('div','medsi-roster-title-box','');
      titleBox.append(textNode('h3','',([child.firstName,child.surname].filter(Boolean).join(' ')||'Без имени')));
      const editChild=textNode('button','medsi-roster-edit','Изменить имя');editChild.type='button';
      editChild.onclick=()=>{head.replaceChildren(rosterEdit([
        {id:'firstName',label:'Имя ребёнка',value:child.firstName},{id:'surname',label:'Фамилия ребёнка',value:child.surname}
      ],values=>request('/lab/admin/roster/edit','POST',{
        kind:'child',childId:child.childId,admissionId:child.admissionId,
        ...values,expectedFirstName:child.firstName,expectedSurname:child.surname
      })))};
      head.append(titleBox,editChild);card.append(head);
      const badges=textNode('div','medsi-roster-status','');
      for(const [label,present] of [['Утро',child.morning],['Вечер',child.evening]]){
        const badge=textNode('span','medsi-roster-badge',(present?'✓ ':'— ')+label);
        badge.dataset.present=present?'1':'0';badge.dataset.kind=label==='Утро'?'morning':'evening';badges.append(badge);
      }
      card.append(badges);
      const parents=textNode('div','medsi-roster-parents','');
      if(!child.parents.length)parents.append(textNode('p','medsi-roster-empty-parent','Нет привязанных родителей.'));
      for(const parent of child.parents){
        const line=textNode('div','medsi-roster-parent',''),
          info=textNode('div','medsi-roster-parent-info',''),
          buttons=textNode('div','medsi-roster-parent-actions','');
        info.append(textNode('strong','',parent.parentName||'Родитель'),
          textNode('span','',[parent.relationship||'Родитель',parent.phone].filter(Boolean).join(' · ')));
        const edit=textNode('button','medsi-roster-edit','Изменить');edit.type='button';
        edit.onclick=()=>line.replaceChildren(rosterEdit([
          {id:'parentName',label:'Имя родителя',value:parent.parentName},
          {id:'relationship',label:'Кем приходится ребёнку',value:parent.relationship||'Родитель'}
        ],values=>request('/lab/admin/roster/edit','POST',{
          kind:'parent',phone10:parent.phone10,childId:child.childId,admissionId:child.admissionId,
          ...values,expectedParentName:parent.parentName,expectedRelationship:parent.relationship
        })));
        const del=textNode('button','medsi-roster-delete','Удалить');del.type='button';
        del.onclick=async()=>{
          const label=[parent.parentName,child.firstName,child.surname].filter(Boolean).join(' / ');
          if(!window.confirm('Удалить профиль '+label+'?\\n\\nЭто действие удалит переписку и доступ этого родителя. Если у ребёнка есть другие родители, их профили сохранятся.'))return;
          del.disabled=true;
          try{
            const operationId='del_'+(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):String(Date.now())+Math.random().toString(36).slice(2));
            const answer=await request('/lab/parent-delete','POST',{phone:parent.phone,operationId});
            if(answer.accepted!==true)throw new Error(answer.message||'Удаление не принято сервером.');
            await refreshRoster();refreshLibrary();
            byId('medsiReportsFeedback').textContent='Удаление профиля принято в обработку.';
          }catch(error){del.disabled=false;byId('medsiReportsFeedback').textContent=error.message||'Не удалось удалить профиль.';}
        };
        buttons.append(edit,del);line.append(info,buttons);parents.append(line);
      }
      card.append(parents);pane.append(card);
    }
    const unlinked=Array.isArray(data?.unlinked)?data.unlinked:[];
    if(unlinked.length){
      const group=textNode('section','medsi-roster-unlinked','');
      group.append(textNode('h3','','Профили без активной госпитализации'),
        textNode('p','', 'Эти профили не учитываются в списке детей, находящихся сейчас в отделении.'));
      for(const parent of unlinked)group.append(textNode('div','medsi-roster-orphan',
        [parent.parentName||'Родитель',parent.childName||'Ребёнок не привязан',parent.phone].join(' · ')));
      pane.append(group);
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
    const footer=textNode('div','medsi-names-footer',''),count=textNode('span','','Групп имён: '+namesDraft.length),save=textNode('button','medsi-inline-save','Сохранить');save.id='medsiNamesSave';save.type='button';save.onclick=saveNames;footer.append(count,save);pane.append(footer);updateSaveState();
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
