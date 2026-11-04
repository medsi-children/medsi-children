(function () {
  'use strict';

  // Loaded only from the isolated feature branch. Existing production logic
  // remains in tutors/full-web.js and retains ownership of user actions.
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
        <span class="medsi-tile-heading">Исходные отчёты</span>
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
        <h2 id="medsiReportsTitle">Отчёты</h2>
        <button type="button" id="medsiReportsRefresh" class="medsi-reports-refresh" aria-label="Обновить отчёты">↻</button>
      </header>
      <div class="medsi-reports-switch" role="tablist" aria-label="Тип отчётов">
        <button type="button" id="medsiTabRaw" role="tab" aria-selected="true" aria-controls="medsiRawPane">Исходные отчёты</button>
        <button type="button" id="medsiTabChildren" role="tab" aria-selected="false" aria-controls="medsiChildrenPane">Отчёты по детям</button>
        <button type="button" id="medsiTabNames" role="tab" aria-selected="false" aria-controls="medsiNamesPane">Варианты имен</button>
      </div>
      <p id="medsiReportsFeedback" class="medsi-reports-feedback" role="status"></p>
      <div id="medsiRawPane" role="tabpanel" aria-labelledby="medsiTabRaw" class="medsi-reports-content"></div>
      <div id="medsiChildrenPane" role="tabpanel" aria-labelledby="medsiTabChildren" class="medsi-reports-content hidden"></div>
      <div id="medsiNamesPane" role="tabpanel" aria-labelledby="medsiTabNames" class="medsi-reports-content hidden"></div>
    </div>`;
  document.body.append(library);

  let opened = false;
  let activeTab = 'raw';
  let reportData = null;
  let refreshController = null;

  function reportTypeLabel(type) {
    return type === 'morning' ? 'Утренний отчёт' : type === 'evening'
      ? 'Вечерний отчёт' : 'Психотерапевтический отчёт';
  }
  function textNode(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = String(value == null ? '' : value);
    return el;
  }
  function reportText(value) {
    return String(value || '').trim() || 'Отчёта пока нет.';
  }

  function showTab(kind) {
    activeTab = kind;
    const raw = kind === 'raw';
    const children = kind === 'children';
    byId('medsiTabRaw').setAttribute('aria-selected', String(raw));
    byId('medsiTabChildren').setAttribute('aria-selected', String(children));
    byId('medsiTabNames').setAttribute('aria-selected', String(kind === 'names'));
    byId('medsiRawPane').classList.toggle('hidden', !raw);
    byId('medsiChildrenPane').classList.toggle('hidden', !children);
    byId('medsiNamesPane').classList.toggle('hidden', kind !== 'names');
  }
  byId('medsiTabRaw').addEventListener('click', () => showTab('raw'));
  byId('medsiTabChildren').addEventListener('click', () => showTab('children'));
  byId('medsiTabNames').addEventListener('click', () => { showTab('names'); refreshNames(); });

  function renderRaw(data) {
    const root = byId('medsiRawPane');
    root.replaceChildren();
    for (const kind of ['morning', 'evening', 'psychology']) {
      const entry = data.raw && data.raw[kind] || {};
      const card = document.createElement('article');
      card.className = 'medsi-raw-report medsi-raw-' + kind;
      card.append(textNode('h3', '', reportTypeLabel(kind)));
      const details = entry.reportDate ? 'Дата: ' + entry.reportDate : 'Публикации пока нет';
      card.append(textNode('p', 'medsi-report-date', details));
      card.append(textNode('div', 'medsi-report-body', reportText(entry.rawText)));
      if (entry.normalizedText && entry.normalizedText !== entry.rawText) {
        const details = document.createElement('details'); details.className = 'medsi-normalized-source';
        details.append(textNode('summary', '', 'Подготовленный текст перед распределением'));
        details.append(textNode('div', 'medsi-report-body', entry.normalizedText)); card.append(details);
      }
      root.append(card);
    }
  }

  function renderChildren(data) {
    const root = byId('medsiChildrenPane');
    root.replaceChildren();
    const children = Array.isArray(data.children) ? data.children : [];
    if (!children.length) {
      root.append(textNode('p', 'medsi-reports-empty', 'В базе пока нет активных детей.'));
      return;
    }
    for (const child of children) {
      const card = document.createElement('article');
      card.className = 'medsi-child-report-card';
      const left = document.createElement('div');
      left.className = 'medsi-child-details';
      left.append(textNode('h3', 'medsi-child-name', child.childName || 'Без имени'));
      left.append(textNode('p', 'medsi-child-meta', child.surname || ''));
      const parents = Array.isArray(child.parents) ? child.parents : [];
      for (const parent of parents) {
        const parentLine = document.createElement('div');
        parentLine.className = 'medsi-child-parent';
        parentLine.append(textNode('div', 'medsi-parent-name',
          [parent.relationship || 'Родитель', parent.parentName || '—'].join(' · ')));
        parentLine.append(textNode('div', 'medsi-parent-phone', parent.phone || ''));
        left.append(parentLine);
      }
      const right = document.createElement('div');
      right.className = 'medsi-child-report-view';
      right.append(textNode('h4', '', 'Что видит родитель'));
      const views = Array.isArray(child.parentViews) ? child.parentViews : [];
      for (const view of views) {
        const block = document.createElement('div');
        block.className = 'medsi-child-report-version';
        if (views.length > 1) block.append(textNode('div', 'medsi-view-parent', view.parentName || view.phone || 'Родитель'));
        for (const kind of ['morning', 'evening', 'psychology']) {
          block.append(textNode('h5', '', reportTypeLabel(kind)));
          block.append(textNode('div', 'medsi-report-body', reportText(view.reports && view.reports[kind])));
          const edit = document.createElement('button');
          edit.type = 'button'; edit.className = 'medsi-report-edit'; edit.textContent = 'Изменить';
          edit.addEventListener('click', () => editDistributedReport(block, child, view, kind));
          block.append(edit);
        }
        right.append(block);
      }
      card.append(left, right);
      root.append(card);
    }
  }

  async function editDistributedReport(block, child, view, kind) {
    if (block.querySelector('.medsi-report-edit-form')) return;
    const form = document.createElement('form'); form.className = 'medsi-report-edit-form';
    const area = document.createElement('textarea'); area.maxLength = 240000;
    area.value = String(view.reports && view.reports[kind] || ''); area.setAttribute('aria-label', 'Исправленный отчёт');
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Сохранить исправление';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Отмена';
    cancel.addEventListener('click', () => form.remove()); form.append(area, save, cancel); block.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try {
        const session = await MedsiEducatorSession.get();
        const response = await fetch('/lab/admin/reports/edit', { method:'POST',
          headers:{'Content-Type':'application/json','X-Medsi-Chat-Session':session.token},
          body:JSON.stringify({phone10:view.phone10,admissionId:child.admissionId,kind,text:area.value}) });
        const result = await response.json().catch(()=>null);
        if (!response.ok || !result || result.ok !== true) throw new Error('save failed');
        byId('medsiReportsFeedback').textContent = 'Исправление сохранено. Обновите экран, чтобы проверить результат.';
        form.remove(); await refreshLibrary();
      } catch (_) { save.disabled = false; byId('medsiReportsFeedback').textContent = 'Не удалось сохранить. Повторите попытку.'; }
    });
  }

  async function refreshNames() {
    const pane = byId('medsiNamesPane'); pane.replaceChildren();
    const form = document.createElement('form'); form.className = 'medsi-name-form';
    const preferred = document.createElement('input'); preferred.placeholder = 'Каноничное имя'; preferred.required = true;
    const variants = document.createElement('input'); variants.placeholder = 'Варианты через запятую';
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Добавить вариант';
    form.append(preferred, variants, submit); pane.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); await saveNameVariant({preferredName:preferred.value,variants:variants.value});
    });
    try {
      const session = await MedsiEducatorSession.get();
      const response = await fetch('/lab/admin/name-variants',{headers:{'X-Medsi-Chat-Session':session.token},cache:'no-store'});
      const data = await response.json(); if(!response.ok || !data.ok) throw new Error('read');
      for(const row of data.items||[]) {
        const card=document.createElement('article'); card.className='medsi-name-card';
        const title=textNode('h3','',row.preferredName); card.append(title);
        const blobs=document.createElement('div'); blobs.className='medsi-name-blobs';
        for(const name of row.variants||[]) blobs.append(textNode('span','medsi-name-blob',name));
        card.append(blobs);
        const edit=document.createElement('button'); edit.type='button'; edit.textContent='Изменить';
        edit.addEventListener('click',()=>{preferred.value=row.preferredName;variants.value=(row.variants||[]).filter(x=>x!==row.preferredName).join(', ');form.dataset.previous=row.baseKey;preferred.focus();});
        const remove=document.createElement('button'); remove.type='button'; remove.textContent='Удалить группу';
        remove.addEventListener('click',async()=>{if(!confirm('Удалить группу вариантов имени «'+row.preferredName+'»?'))return;await removeNameVariant(row.baseKey);});
        card.append(edit,remove); pane.append(card);
      }
      if(!data.items?.length) pane.append(textNode('p','medsi-reports-empty','Варианты имён пока не добавлены.'));
    } catch (_) { byId('medsiReportsFeedback').textContent='Не удалось загрузить варианты имён.'; }
  }
  async function saveNameVariant(row) {
    try {
      const session=await MedsiEducatorSession.get();
      const response=await fetch('/lab/admin/name-variants',{method:'POST',headers:{'Content-Type':'application/json','X-Medsi-Chat-Session':session.token},body:JSON.stringify({...row,previousBaseKey:byId('medsiNamesPane').querySelector('.medsi-name-form').dataset.previous})});
      if(!response.ok)throw new Error('save'); await refreshNames(); byId('medsiReportsFeedback').textContent='Варианты имени сохранены.';
    } catch(_){byId('medsiReportsFeedback').textContent='Не удалось сохранить: имя может уже входить в другую группу.';}
  }
  async function removeNameVariant(key) {
    try { const session=await MedsiEducatorSession.get(); const response=await fetch('/lab/admin/name-variants/'+encodeURIComponent(key),{method:'DELETE',headers:{'X-Medsi-Chat-Session':session.token}}); if(!response.ok)throw new Error(); await refreshNames(); }
    catch(_){byId('medsiReportsFeedback').textContent='Не удалось удалить группу вариантов имени.';}
  }

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
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || data.ok !== true) {
        throw new Error((data && data.message) || 'Не удалось загрузить отчёты.');
      }
      if (!opened || refreshController !== controller) return;
      reportData = data;
      renderRaw(data);
      renderChildren(data);
      feedback.textContent = '';
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!opened) return;
      feedback.textContent = 'Не удалось загрузить отчёты. Проверьте соединение и повторите.';
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
  function closeLibrary() {
    opened = false;
    document.body.classList.remove('medsi-report-library-open');
    library.classList.add('hidden');
    if (refreshController) { refreshController.abort(); refreshController = null; }
    // Return to the settings cards, preserving the original parent menu.
    byId('tutorSettingsOpen').click();
  }
  byId('medsiOpenReportLibrary').addEventListener('click', openLibrary);
  byId('medsiReportsBack').addEventListener('click', closeLibrary);
  byId('medsiReportsRefresh').addEventListener('click', refreshLibrary);
  library.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeLibrary(); }
  });
})();
