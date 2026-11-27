(() => {
  'use strict';

  // Change this one switch to hide the assistant without changing the parent panel.
  const educator = document.documentElement.dataset.assistantRole === 'educator';
  const options = educator ? window.MedsiAssistantOptions : {};
  // Never fall back to the parent's command set in the educator panel.
  if (educator && (options?.role !== 'educator' || typeof options.conversation !== 'function')) return;
  const ENABLED = true;
  if (!ENABLED || window.MedsiSmartBotWidget) return;

  const dock = document.createElement('div');
  dock.className = 'medsi-bot-dock';
  dock.hidden = true;
  const logoSlot = document.getElementById('medsiAssistantLogo');
  if (logoSlot) dock.classList.add('medsi-bot-dock--brand');
  (logoSlot || document.body).appendChild(dock);
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'medsi-bot-launcher';
  launcher.setAttribute('aria-label', 'Открыть Медси Бота');
  launcher.setAttribute('title', 'Задать вопрос Медси Боту');
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.hidden = true;
  launcher.innerHTML = '<span class="medsi-bot-scale"><span class="medsi-character" aria-hidden="true"><span class="medsi-character-glow"></span><img class="medsi-character-body" src="/parents/blob.webp" fetchpriority="high" alt=""><span class="medsi-character-eyes"><i class="medsi-character-eye"></i><i class="medsi-character-eye"></i></span></span></span>';
  const character = launcher.querySelector('.medsi-character');
  const bodyImage = launcher.querySelector('img');
  let assetReady = false;
  const markAssetReady = () => {
    if (assetReady) return;
    assetReady = true;
    syncLauncher();
  };
  bodyImage.addEventListener('load', markAssetReady, { once: true });
  dock.appendChild(launcher);
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'medsi-bot-hint';
  const hintTexts = ['Чем могу помочь?', 'Ваш ИИ помощник', 'Нажмите на меня'];
  hint.textContent = hintTexts[Math.floor(Math.random() * hintTexts.length)];
  hint.addEventListener('click', open);
  hint.hidden = true;
  dock.appendChild(hint);

  let overlay = null;
  let shell = null;
  let frame = null;
  let chat = null;
  let chatRoot = null;
  let closing = false;
  let closeTimer = 0;
  let backgroundLock = null;
  let avatarImage = new Image();
  avatarImage.src = "/parents/blob.webp";
  // Wait for the actual load event so the small in-chat avatar never appears
  // as a late, visibly growing image when the dialog opens.
  const avatarReady = new Promise(resolve => {
    if (avatarImage.complete) { resolve(); return; }
    avatarImage.addEventListener('load', resolve, { once: true });
    avatarImage.addEventListener('error', resolve, { once: true });
  }).then(() => avatarImage.naturalWidth > 0 ? avatarImage.decode().catch(() => {}) : null);
  let dialogGeometry = null;
  let pointerActiveUntil = 0;
  let hintTimer = 0;
  let hintHideTimer = 0;
  let hintShown = false;

  function scheduleHint() {
    if (hintShown || launcher.hidden || hintTimer) return;
    hintTimer = window.setTimeout(() => {
      hintTimer = 0;
      if (launcher.hidden || overlay) return;
      hintShown = true;
      hint.hidden = false;
      hint.classList.add('is-visible');
      hintHideTimer = window.setTimeout(() => {
        hint.classList.remove('is-visible');
        hint.hidden = true;
      }, 10000);
    }, 5000);
  }

  function syncLauncher() {
    launcher.hidden = !assetReady || document.body.dataset.screen !== 'screenChoose' || (options.available && !options.available());
    dock.hidden = launcher.hidden;
    dock.inert = Boolean(overlay);
    if (!launcher.hidden && !overlay) scheduleHint();
    if (launcher.hidden || overlay) {
      window.clearTimeout(hintTimer);
      hintTimer = 0;
      window.clearTimeout(hintHideTimer);
      hint.classList.remove('is-visible');
      hint.hidden = true;
    }
  }

  // Same gaze bounds and proportions as the original large character.
  function setGaze(x, y) {
    const size = 238;
    character.style.setProperty('--gaze-x', `${Math.max(-size * .055, Math.min(size * .055, x - size * .055))}px`);
    character.style.setProperty('--gaze-y', `${Math.max(-size * .065, Math.min(size * .055, y + size * .025))}px`);
  }
  launcher.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse') return;
    const bounds = launcher.getBoundingClientRect();
    setGaze(Math.max(-23.8, Math.min(23.8, (event.clientX - bounds.left - bounds.width / 2) / bounds.width * 59.5)),
      Math.max(-19.04, Math.min(19.04, (event.clientY - bounds.top - bounds.height / 2) / bounds.height * 59.5)));
    pointerActiveUntil = Date.now() + 1600;
  }, { passive: true });
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.setInterval(() => {
      if (launcher.hidden || Date.now() < pointerActiveUntil) return;
      setGaze(238 * (.025 + (Math.random() - .5) * .09), 238 * (-.04 + (Math.random() - .5) * .07));
    }, 2200);
  }
  setGaze(238 * .10, 238 * -.08);

  function lockBackground() {
    const body = document.body;
    const menu = document.querySelector('body > .wrap');
    backgroundLock = {
      x: window.scrollX, y: window.scrollY,
      minHeight: body.style.getPropertyValue('min-height'),
      priority: body.style.getPropertyPriority('min-height'),
      menu, visibility: menu?.style.visibility, inert: menu?.inert
    };
    // Keep a scrollable document like the educator chat. Safari alone pans it
    // for the keyboard; the menu cannot be exposed during that movement.
    body.style.minHeight = `${Math.max(body.scrollHeight, window.innerHeight)}px`;
    if (menu) { menu.style.visibility = 'hidden'; menu.inert = true; }
  }

  function unlockBackground() {
    if (!backgroundLock) return;
    const saved = backgroundLock;
    backgroundLock = null;
    if (saved.minHeight) document.body.style.setProperty('min-height', saved.minHeight, saved.priority);
    else document.body.style.removeProperty('min-height');
    if (saved.menu) {
      saved.menu.style.visibility = saved.visibility;
      saved.menu.inert = saved.inert;
    }
    window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
  }

  function removeOverlay(openEducators = false) {
    if (!overlay) return;
    window.clearTimeout(closeTimer);
    chat?.destroy();
    chat = null;
    frame.hidden = true;
    overlay.hidden = true;
    overlay.className = 'medsi-bot-overlay is-preparing';
    overlay = null;
    closing = false;
    dialogGeometry = null;
    frame.style.height = '';
    frame.style.width = '';
    opening = false;
    launcher.removeAttribute('aria-busy');
    unlockBackground();
    document.documentElement.classList.remove('medsi-bot-active');
    syncLauncher();
    if (openEducators && document.body.dataset.screen === 'screenChoose') {
      document.getElementById('btnChat')?.click();
    } else {
      launcher.focus({ preventScroll: true });
    }
  }

  function finishClose(openEducators = false) {
    if (!overlay || overlay.classList.contains('is-closing') || (chat?.canClose && !chat.canClose())) return;
    window.clearTimeout(closeTimer);
    closing = true;
    chatRoot?.activeElement?.blur();
    overlay.classList.add('is-closing');
    closeTimer = window.setTimeout(() => removeOverlay(openEducators),
      matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
  }

  function installChatView() {
    chatRoot.querySelector('.assistant-lab')?.remove();
    const view = document.createElement('template');
    view.innerHTML = window.MedsiBotChatView;
    chatRoot.appendChild(view.content.cloneNode(true));
    if (options.prompts) {
      const strip = chatRoot.getElementById('promptStrip');
      strip.replaceChildren(...options.prompts.map(label => { const button = document.createElement('button'); button.type = 'button'; button.dataset.prompt = label; button.textContent = label; return button; }));
    }
    if (options.multiline) {
      const oldInput = chatRoot.getElementById('messageInput');
      const textarea = document.createElement('textarea');
      textarea.id = 'messageInput'; textarea.rows = 2; textarea.maxLength = 60000;
      textarea.setAttribute('aria-label', 'Ваш вопрос или текст отчёта');
      oldInput.replaceWith(textarea);
    }
    const footer = document.createElement('div');
    footer.className = 'bot-chat-footer';
    const promptRow = document.createElement('div');
    promptRow.className = 'bot-chat-prompt-row';
    promptRow.appendChild(chatRoot.getElementById('promptStrip'));
    footer.append(promptRow, chatRoot.getElementById('composer'));
    chatRoot.querySelector('.help-panel').appendChild(footer);
  }

  function requestClose() {
    finishClose();
  }

  let opening = false;
  async function open() {
    if (opening || overlay || !assetReady || document.body.dataset.screen !== 'screenChoose') return;
    opening = true;
    launcher.setAttribute('aria-busy', 'true');
    try { await chatReady; } catch (_) {
      chatReady = prepareChat();
      try { await chatReady; } catch (_) { opening = false; launcher.removeAttribute('aria-busy'); return; }
    }
    if (overlay || document.body.dataset.screen !== 'screenChoose') { opening = false; launcher.removeAttribute('aria-busy'); return; }
    overlay = shell;
    overlay.className = 'medsi-bot-overlay is-preparing';
    installChatView();
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width || window.innerWidth;
    frame.style.width = `${Math.min(viewportWidth - (viewportWidth <= 600 ? 40 : 2 * Math.min(28, Math.max(10, viewportWidth * .03))), 570)}px`;
    overlay.style.top = `${window.scrollY + (viewport?.offsetTop || 0)}px`;
    overlay.style.left = `${window.scrollX + (viewport?.offsetLeft || 0)}px`;
    overlay.style.width = `${viewport?.width || window.innerWidth}px`;
    overlay.style.height = `${viewport?.height || window.innerHeight}px`;
    overlay.hidden = false;
    frame.hidden = false;
    chat = window.MedsiBotChat.mount(chatRoot, {
      ...(options.conversation ? options.conversation() : {}),
      close: () => finishClose(),
      openEducators: () => finishClose(true)
    });
    window.clearTimeout(hintHideTimer);
    hint.classList.remove('is-visible');
    hint.hidden = true;
    lockBackground();
    document.documentElement.classList.add('medsi-bot-active');
    syncLauncher();
    dialogGeometry = {
      height: frame.getBoundingClientRect().height,
      viewportWidth: window.visualViewport?.width || window.innerWidth
    };
    frame.style.height = `${dialogGeometry.height}px`;
    const openingOverlay = overlay;
    try {
      // Decode the actual greeting images, not just a detached preload, before paint.
      await Promise.all([...chatRoot.querySelectorAll('.message-avatar img')].map(image => image.decode()));
    } catch (_) { /* A missing image must not prevent opening the chat. */ }
    if (overlay !== openingOverlay || closing) { opening = false; launcher.removeAttribute('aria-busy'); return; }
    requestAnimationFrame(() => {
      if (overlay !== openingOverlay || closing) return;
      overlay.classList.remove('is-preparing');
      frame.getBoundingClientRect();
      requestAnimationFrame(() => {
        if (overlay !== openingOverlay || closing) return;
        overlay.classList.add('is-open');
        opening = false;
        launcher.removeAttribute('aria-busy');
      });
    });
  }

  // Keyboard height/offset events deliberately do not reposition the dialog.
  // Only a real width change (rotation / desktop resizing) changes its geometry.
  window.addEventListener('resize', () => {
    if (!overlay || !dialogGeometry) return;
    const width = window.visualViewport?.width || window.innerWidth;
    if (Math.abs(width - dialogGeometry.viewportWidth) < 30) return;
    if (chatRoot?.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;
    overlay.style.width = `${width}px`;
    frame.style.width = `${Math.min(width - (width <= 600 ? 40 : 2 * Math.min(28, Math.max(10, width * .03))), 570)}px`;
    overlay.style.height = `${window.visualViewport?.height || window.innerHeight}px`;
    frame.style.height = '';
    dialogGeometry = { height: frame.getBoundingClientRect().height, viewportWidth: width };
    frame.style.height = `${dialogGeometry.height}px`;
  });

  new MutationObserver(syncLauncher).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] });
  launcher.addEventListener('click', open);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && overlay) { event.preventDefault(); requestClose(); }
  });
  window.setInterval(() => {
    if (overlay && document.body.dataset.screen !== 'screenChoose') requestClose();
    syncLauncher();
  }, 300);
  function script(src) {
    return new Promise((resolve, reject) => {
      const node = document.createElement('script');
      node.src = src; node.onload = resolve; node.onerror = () => { node.remove(); reject(new Error('BOT_ASSET_UNAVAILABLE')); };
      document.head.appendChild(node);
    });
  }
  async function prepareChat() {
    if (shell) shell.remove();
    await Promise.all([
      educator || window.MedsiSmartBot ? Promise.resolve() : script('/parents/smart-bot.js?v=20261127-shared-replies-1'),
      window.MedsiPsychologyFormatter ? Promise.resolve() : script('/parents/psychology-format.js?v=20261128-therapy-report-kind-1'),
      script('/parents/bot-chat-view.js?v=20261012-group-therapy-label-1'),
      script('/parents/bot-chat-runtime.js?v=20261127-shared-replies-1'),
      avatarReady
    ]);
    frame = document.createElement('section');
    frame.className = 'medsi-bot-frame';
    frame.hidden = true;
    chatRoot = frame.attachShadow({ mode: 'open' });
    const styleReady = ['/parents/bot-chat.css?v=20261005-2', '/parents/psychology-format.css?v=20261128-therapy-report-kind-1', '/parents/bot-character.css?v=20261003-1'].map(href => new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href; link.onload = resolve; link.onerror = resolve;
      chatRoot.appendChild(link);
    }));
    const style = document.createElement('style');
    style.textContent = ':host{display:block;font:16px Manrope,system-ui,sans-serif;-webkit-text-size-adjust:100%;text-size-adjust:100%;color:#264d51;overflow:hidden} .assistant-lab{display:block;width:100%;height:100%;min-height:0;margin:0;padding:0}.bot-stage{display:none}.help-panel{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:100%;height:100%;min-height:0;max-height:none;border:0;border-radius:0;box-shadow:none;background:#fff;backdrop-filter:none}.conversation{min-height:0;min-width:0;overscroll-behavior:contain}.bot-chat-footer{display:block;min-width:0;padding:0 13px calc(16px + env(safe-area-inset-bottom));background:#fff}.bot-chat-prompt-row{display:block;height:52px;overflow:hidden;contain:paint}.bot-chat-footer .prompt-strip{height:52px;box-sizing:border-box;margin:0;padding:4px 1px;min-width:0;align-items:center}.bot-chat-footer .prompt-strip button{flex-basis:calc((100% - 14px)/3);height:44px;min-height:44px;font-size:13px;line-height:1.2}.bot-chat-footer .composer{position:relative;margin:10px 0 0!important;height:58px;min-height:58px;box-sizing:border-box;flex-shrink:0;transition:border-color .18s ease,box-shadow .18s ease}.composer input{font-size:16px}.composer textarea{flex:1;width:100%;min-width:0;height:42px;max-height:42px;box-sizing:border-box;resize:none;border:0;outline:none;background:transparent;color:#264d51;padding:3px 0;font:16px/1.3 Manrope,system-ui,sans-serif}';
    if (options.chatStyle) style.textContent += options.chatStyle;
    chatRoot.appendChild(style);
    installChatView();
    shell = document.createElement('div');
    shell.className = 'medsi-bot-overlay is-preparing';
    shell.hidden = true;
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', 'Чат с Медси Ботом');
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'medsi-bot-backdrop';
    backdrop.setAttribute('aria-label', 'Закрыть чат с Медси Ботом');
    backdrop.addEventListener('click', requestClose);
    const curtain = document.createElement('div');
    curtain.className = 'medsi-bot-curtain';
    curtain.setAttribute('aria-hidden', 'true');
    shell.append(backdrop, frame, curtain);
    document.body.appendChild(shell);
    await Promise.all(styleReady);
  }
  // Preload the chat independently; the menu logo only waits for image decoding.
  let chatReady = prepareChat();
  chatReady.catch(() => {});
  const visualReady = new Promise(resolve => {
    // Safari may reject decode() before the network load completes.  Wait for
    // the real load event so the menu cannot reveal a half-loaded mascot.
    if (bodyImage.complete) { resolve(); return; }
    bodyImage.addEventListener('load', resolve, { once: true });
    bodyImage.addEventListener('error', resolve, { once: true });
  }).then(() => bodyImage.naturalWidth > 0 ? bodyImage.decode().catch(() => {}) : null)
    .then(() => { if (bodyImage.naturalWidth > 0) markAssetReady(); });
  if (bodyImage.complete && bodyImage.naturalWidth > 0) markAssetReady();
  syncLauncher();
  const gate = document.getElementById('tutorAuthGate');
  if (gate) new MutationObserver(syncLauncher).observe(gate, {attributes:true,attributeFilter:['class']});
  window.MedsiSmartBotWidget = Object.freeze({ open, close: requestClose, ready: visualReady, navigate(fn) { finishClose(); window.setTimeout(fn, 200); } });
})();
