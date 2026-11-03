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
      </div>
      <p id="medsiReportsFeedback" class="medsi-reports-feedback" role="status"></p>
      <div id="medsiRawPane" role="tabpanel" aria-labelledby="medsiTabRaw" class="medsi-reports-content"></div>
      <div id="medsiChildrenPane" role="tabpanel" aria-labelledby="medsiTabChildren" class="medsi-reports-content hidden"></div>
    </div>`;
  document.body.append(library);

  let opened = false;
  let activeTab = 'raw';
  let reportData = null;
  let refreshController = null;

  function reportTypeLabel(type) {
    return type === 'morning' ? 'Утренний отчёт' : type === 'evening'
      ? 'Вечерний отчёт' : 'Групповая терапия';
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
    byId('medsiTabRaw').setAttribute('aria-selected', String(raw));
    byId('medsiTabChildren').setAttribute('aria-selected', String(!raw));
    byId('medsiRawPane').classList.toggle('hidden', !raw);
    byId('medsiChildrenPane').classList.toggle('hidden', raw);
  }
  byId('medsiTabRaw').addEventListener('click', () => showTab('raw'));
  byId('medsiTabChildren').addEventListener('click', () => showTab('children'));

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
      card.append(textNode('div', 'medsi-report-body', reportText(entry.normalizedText || entry.rawText)));
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
        }
        right.append(block);
      }
      card.append(left, right);
      root.append(card);
    }
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