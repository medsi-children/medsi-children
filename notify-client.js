(function () {
  const PUSH_MESSAGE_TYPE = 'medsi:push-subscription';
  const IDENTITY_KEY = 'medsi_push_identity';
  const INTENT_PREFIX = 'medsi_push_wanted_v1:';
  const VAPID_PUBLIC_KEY = 'BOP6j6f_c1Rw_Zi-vyL3c6NpjmEKYqiISsQtCl7v8F3iV-XyNUnIqUYrppQKRHi6jnhMKTuKuF4HkPKziL8-cXE';
  const SERVICE_WORKER_URL = '/sw.js?v=20260909-auth-close-1';
  const INTRO_VISIBLE_MS = 5000;
  const ENABLED_VISIBLE_MS = 5000;
  const STATUS_VISIBLE_MS = 3600;

  const state = {
    identity: loadIdentity(),
    button: null,
    status: null,
    frame: null,
    appEndpointUrl: '',
    pushServiceUrl: '',
    hideButtonTimer: null,
    hideStatusTimer: null,
    hasShownIntro: false,
    panelVisible: true,
    recoveryPromise: null,
    syncPromise: null,
    syncKey: '',
    lastSync: '',
    lastSyncAt: 0,
    recoveryTimer: null,
    recoveryAttempts: 0,
    actionBusy: false
  };

  function onlyDigits(value) {
    return String(value || '').replace(/\D+/g, '');
  }

  function loadIdentity() {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveIdentity(identity) {
    const next = {
      role: String(identity && identity.role || '').trim(),
      phone: onlyDigits(identity && identity.phone || ''),
      parentSession: String(identity && identity.parentSession || '')
    };

    if (!next.role) return;

    const hasChanged = !state.identity ||
      state.identity.role !== next.role ||
      state.identity.phone !== next.phone;

    const sessionChanged = !state.identity || state.identity.parentSession !== next.parentSession;
    state.identity = next;
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(next)); }
    catch (e) {}

    // При каждом сообщении из вложенной панели раньше заново запускался
    // пятисекундный показ. Один и тот же пользователь получал второй всплывающий
    // контрол уже поверх открытого чата. Обновляем кнопку лишь при смене роли
    // или номера; первичная инициализация сама выполнит один показ ниже.
    if (hasChanged || sessionChanged) {
      state.lastSync = '';
      state.recoveryAttempts = 0;
      if (state.button) recoverSubscription();
      if (hasChanged) updateButton({ reveal: true });
    }
  }

  function clearIdentity() {
    state.identity = null;
    try { localStorage.removeItem(IDENTITY_KEY); }
    catch (e) {}
    hideButton();
  }

  function isSupported() {
    return !!(
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window
    );
  }

  function isConfigured() {
    return !!VAPID_PUBLIC_KEY && VAPID_PUBLIC_KEY.indexOf('REPLACE_WITH_') !== 0;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }

  function intentKey() {
    return state.identity ? INTENT_PREFIX + state.identity.role + ':' + state.identity.phone : '';
  }

  function wanted() {
    try { return localStorage.getItem(intentKey()); } catch (_) { return null; }
  }

  function setWanted(value) {
    try { if (intentKey()) localStorage.setItem(intentKey(), value ? 'yes' : 'no'); } catch (_) {}
  }

  async function syncSubscription(subscription) {
    if (wanted() === 'no') return;
    const identity = JSON.stringify(state.identity);
    try { localStorage.setItem(intentKey() + ':endpoint', subscription.endpoint); } catch (_) {}
    let savedEndpoint = subscription.endpoint;
    const key = identity + ':' + subscription.endpoint;
    if (state.lastSync === key && Date.now() - state.lastSyncAt < 300000) return;
    if (state.syncPromise) {
      const pendingKey = state.syncKey;
      await state.syncPromise;
      if (identity !== JSON.stringify(state.identity) || wanted() === 'no') return;
      if (pendingKey === key || state.lastSync === key) return;
    }
    const pending = (async () => {
      try { return await sendSubscriptionToApp(subscription); }
      catch (error) {
        if (error.code !== 'PUSH_SUBSCRIPTION_EXPIRED' || wanted() === 'no' || identity !== JSON.stringify(state.identity)) throw error;
        await subscription.unsubscribe();
        if (wanted() === 'no' || identity !== JSON.stringify(state.identity)) return;
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
        const fresh = await registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
        if (wanted() === 'no' || identity !== JSON.stringify(state.identity)) return;
        savedEndpoint = fresh.endpoint;
        return sendSubscriptionToApp(fresh);
      }
    })();
    state.syncPromise = pending;
    state.syncKey = key;
    try {
      await pending;
      if (identity === JSON.stringify(state.identity) && wanted() !== 'no') {
        state.lastSync = identity + ':' + savedEndpoint;
        try { localStorage.setItem(intentKey() + ':endpoint', savedEndpoint); } catch (_) {}
        state.lastSyncAt = Date.now();
      }
    } finally {
      if (state.syncPromise === pending) state.syncPromise = null;
    }
  }

  function recoverSubscription() {
    if (state.recoveryPromise) return state.recoveryPromise;
    const pending = runSubscriptionRecovery();
    state.recoveryPromise = pending;
    pending.finally(() => { if (state.recoveryPromise === pending) state.recoveryPromise = null; });
    return pending;
  }

  async function runSubscriptionRecovery() {
    if (!state.button || !state.identity || !isSupported() || state.actionBusy || document.hidden) return;
    if (state.identity.role === 'parent' && !state.identity.parentSession) return;
    const identity = JSON.stringify(state.identity);
    if (wanted() === 'no') {
      try {
        const endpoint = localStorage.getItem(intentKey() + ':off-endpoint');
        if (endpoint) await deleteSubscriptionInApp({endpoint});
      } catch (_) { /* Keep the off request for the next opening or online event. */ }
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      let subscription = await registration.pushManager.getSubscription();
      if (identity !== JSON.stringify(state.identity)) return;
      if (Notification.permission === 'denied') {
        let knownEndpoint = subscription && subscription.endpoint;
        try { knownEndpoint = knownEndpoint || localStorage.getItem(intentKey() + ':endpoint'); } catch (_) {}
        if (knownEndpoint) {
          await deleteSubscriptionInApp({endpoint: knownEndpoint}, 'permission_revoked');
          try { localStorage.removeItem(intentKey() + ':endpoint'); } catch (_) {}
        }
        return;
      }
      if (Notification.permission !== 'granted') return;
      // Only restore an explicitly enabled subscription. Never override a user's off switch.
      if (!subscription && wanted() === 'yes') {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }
      if (!subscription || identity !== JSON.stringify(state.identity)) return;
      if (wanted() === 'no') return;
      setWanted(true);
      await syncSubscription(subscription);
      state.recoveryAttempts = 0;
      if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
      state.recoveryTimer = null;
      updateButton();
    } catch (_) {
      setStatus('Не удалось восстановить уведомления. Проверьте подключение в настройках бота.');
      if (!state.recoveryTimer && state.recoveryAttempts < 2) {
        state.recoveryAttempts += 1;
        state.recoveryTimer = setTimeout(() => {
          state.recoveryTimer = null;
          recoverSubscription();
        }, 30000);
      }
    }
  }

  function sendSubscriptionToApp(subscription, targetWindow) {
    const target = targetWindow || (state.frame && state.frame.contentWindow);
    if (!state.identity) return Promise.resolve(null);

    const message = {
      type: PUSH_MESSAGE_TYPE,
      action: 'save',
      role: state.identity.role,
      phone: state.identity.phone || '',
      parentSession: state.identity.parentSession || '',
      subscription: subscription ? subscription.toJSON() : null,
      userAgent: navigator.userAgent || ''
    };

    if (target) target.postMessage(message, '*');
    return sendPushRequestToServer(message);
  }

  function deleteSubscriptionInApp(subscription, reason) {
    if (!subscription) return;

    const message = {
      type: PUSH_MESSAGE_TYPE,
      action: 'delete',
      reason: reason || 'user_disabled',
      endpoint: subscription.endpoint || '',
      role: state.identity&&state.identity.role||'',
      phone: state.identity&&state.identity.phone||'',
      parentSession: state.identity&&state.identity.parentSession||''
    };

    if (state.frame && state.frame.contentWindow) {
      state.frame.contentWindow.postMessage(message, '*');
    }
    const pendingKey = intentKey() + ':off-endpoint';
    try { localStorage.setItem(pendingKey, subscription.endpoint || ''); } catch (_) {}
    return sendPushRequestToServer(message).then(result => {
      try {
        if (localStorage.getItem(pendingKey) === subscription.endpoint) localStorage.removeItem(pendingKey);
      } catch (_) {}
      return result;
    });
  }

  function sendPushRequestToServer(message) {
    if (!message) return Promise.resolve(null);

    let pushRequest = Promise.resolve(null);

    if (state.pushServiceUrl && message.action === 'save') {
      pushRequest = sendPushRequest(state.pushServiceUrl + '/subscribe', {
        role: message.role,
        phone: message.phone,
        parentSession: message.parentSession,
        subscription: message.subscription,
        userAgent: message.userAgent
      });
    }

    if (state.pushServiceUrl && message.action === 'delete') {
      pushRequest = sendPushRequest(state.pushServiceUrl + '/unsubscribe', {
        endpoint: message.endpoint,
        reason: message.reason,
        role: message.role,
        phone: message.phone,
        parentSession: message.parentSession
      });
    }

    if (state.appEndpointUrl) {
      sendPushRequest(state.appEndpointUrl, {
        action: message.action,
        role: message.role,
        phone: message.phone,
        parentSession: message.parentSession,
        endpoint: message.endpoint,
        subscription: message.subscription,
        userAgent: message.userAgent
      }, true).catch(() => {});
    }
    return pushRequest;
  }

  async function sendPushRequest(url, body, opaque) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        mode: opaque ? 'no-cors' : 'cors',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      });
      if (opaque) return null;
      let result;
      try { result = await response.json(); } catch (_) { throw new Error('PUSH_BAD_RESPONSE'); }
      if (!response.ok || !result || result.ok !== true) {
        const error = new Error(result && result.message || 'PUSH_SUBSCRIBE_FAILED');
        error.code = result && result.code || '';
        error.status = response.status;
        throw error;
      }
      return result;
    } finally { clearTimeout(timer); }
  }

  async function getSubscription() {
    if (!isSupported()) return null;
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    return registration.pushManager.getSubscription();
  }

  async function subscribe() {
    if (!isSupported()) {
      setStatus('На этом устройстве уведомления недоступны.');
      return;
    }

    if (!isConfigured()) {
      setStatus('Уведомления подготовлены. Свяжитесь с администратором для настройки Web Push.');
      return;
    }

    if (!state.identity || !state.identity.role) {
      setStatus('Сначала войдите в приложение.');
      return;
    }

    if (Notification.permission === 'denied') {
      setStatus('Разрешите уведомления для сайта в настройках Chrome или Android, затем нажмите кнопку ещё раз.');
      updateButton({ reveal: true });
      return;
    }

    setStatus('Подключаем уведомления...');

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('Уведомления не включены. Разрешите их в настройках сайта.');
      updateButton();
      return;
    }

    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });

    setWanted(true);
    state.lastSync = '';
    await syncSubscription(subscription);
    setStatus('Уведомления включены.');
    updateButton({ reveal: true });
  }

  async function unsubscribe() {
    setWanted(false);
    state.lastSync = '';
    if (state.recoveryTimer) clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
    // Wait for an older save before recording the explicit off switch.
    if (state.syncPromise) { try { await state.syncPromise; } catch (_) {} }
    const subscription = await getSubscription();
    if (subscription) {
      // Remove the browser subscription first, then remove the same endpoint
      // from the server. Android can resolve unsubscribe asynchronously; doing
      // this in this order prevents a quick re-enable from racing the delete.
      try { await subscription.unsubscribe(); } finally { await deleteSubscriptionInApp(subscription); }
    }

    setStatus('Уведомления отключены.');
    updateButton({ reveal: true });
  }

  function setStatus(text) {
    if (!state.status) return;
    if (state.hideStatusTimer) {
      clearTimeout(state.hideStatusTimer);
      state.hideStatusTimer = null;
    }

    state.status.textContent = text || '';
    state.status.classList.toggle('hidden', !text);

    if (text) {
      state.hideStatusTimer = setTimeout(() => {
        state.status.classList.add('hidden');
        state.hideStatusTimer = null;
      }, STATUS_VISIBLE_MS);
    }
  }

  function hideButton() {
    if (state.hideButtonTimer) {
      clearTimeout(state.hideButtonTimer);
      state.hideButtonTimer = null;
    }
    if (state.button) state.button.classList.add('hidden');
  }

  function revealButtonFor(ms) {
    if (!state.button) return;

    if (!state.panelVisible) {
      hideButton();
      return;
    }

    if (state.hideButtonTimer) {
      clearTimeout(state.hideButtonTimer);
      state.hideButtonTimer = null;
    }

    state.button.classList.remove('hidden');
    state.hideButtonTimer = setTimeout(() => {
      hideButton();
    }, ms);
  }

  async function updateButton(options) {
    if (!state.button) return;

    if (!state.panelVisible) {
      hideButton();
      return;
    }

    if (!isSupported()) {
      hideButton();
      return;
    }

    if (!state.identity || !state.identity.role) {
      hideButton();
      return;
    }

    let subscription = null;
    if (Notification.permission === 'granted') {
      try {
        subscription = await getSubscription();
      } catch (e) {
        subscription = null;
      }
    }

    if (subscription && wanted() !== 'no') {
      state.button.textContent = 'Отключить уведомления';
      state.button.disabled = false;

      syncSubscription(subscription).catch(() => {
        setStatus('Проверяем подключение уведомлений. Попробуем ещё раз при следующем открытии.');
      });

      if (options && options.reveal) revealButtonFor(ENABLED_VISIBLE_MS);
      return;
    }

    state.button.textContent = 'Включить уведомления';
    state.button.disabled = false;

    if ((options && options.reveal) || !state.hasShownIntro) {
      state.hasShownIntro = true;
      revealButtonFor(INTRO_VISIBLE_MS);
    }
  }

  function injectStyles() {
    if (document.getElementById('medsiPushStyles')) return;

    const style = document.createElement('style');
    style.id = 'medsiPushStyles';
    style.textContent = [
      '.medsi-push-panel{position:fixed;left:12px;right:12px;bottom:calc(5px + env(safe-area-inset-bottom));z-index:20;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none}',
      '.medsi-push-btn{pointer-events:auto;width:auto;min-width:0;max-width:240px;min-height:40px;padding:9px 14px;border-radius:999px;border:1px solid rgba(15,199,206,.34);background:rgba(255,255,255,.94);color:#0f8f98;font:700 14px/1.15 system-ui,-apple-system,Segoe UI,Roboto,Arial;box-shadow:0 12px 26px rgba(15,199,206,.18);backdrop-filter:blur(12px);opacity:1;transform:translateY(0);visibility:visible;transition:opacity .26s ease,transform .26s ease,visibility 0s linear 0s}',
      '.medsi-push-btn:disabled{opacity:.82}',
      '.medsi-push-status{max-width:min(320px,calc(100vw - 32px));padding:7px 10px;border-radius:12px;background:linear-gradient(135deg,rgba(36,211,218,.96),rgba(15,167,178,.96));color:#fff;font:700 12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Arial;text-align:center;box-shadow:0 10px 20px rgba(15,167,178,.24);opacity:1;transform:translateY(0);visibility:visible;transition:opacity .26s ease,transform .26s ease,visibility 0s linear 0s}',
      '.medsi-push-status.hidden,.medsi-push-btn.hidden{opacity:0;transform:translateY(8px);visibility:hidden;pointer-events:none;transition:opacity .26s ease,transform .26s ease,visibility 0s linear .26s}'
    ].join('');

    document.head.appendChild(style);
  }

  window.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type !== PUSH_MESSAGE_TYPE || data.action !== 'get') return;

    getSubscription()
      .then(subscription => {
        if (subscription && wanted() !== 'no') return sendSubscriptionToApp(subscription, event.source);
      })
      .catch(() => {});
  });

  function init(options) {
    state.frame = document.getElementById(options && options.frameId || 'appFrame');
    state.appEndpointUrl = String(options && options.appEndpointUrl || '').trim();
    state.pushServiceUrl = String(options && options.pushServiceUrl || '').replace(/\/+$/, '');
    injectStyles();

    const panel = document.createElement('div');
    panel.className = 'medsi-push-panel';

    state.status = document.createElement('div');
    state.status.className = 'medsi-push-status hidden';

    state.button = document.createElement('button');
    state.button.type = 'button';
    state.button.className = 'medsi-push-btn hidden';
    state.button.textContent = 'Включить уведомления';
    state.button.addEventListener('click', async () => {
      if (state.actionBusy) return;
      state.actionBusy = true;
      state.button.disabled = true;
      try {
        const subscription = await getSubscription();
        if (subscription && wanted() !== 'no') {
          await unsubscribe();
          return;
        }

        await subscribe();
      } catch (e) {
        const name = String(e && e.name || '');
        setStatus(name === 'NotAllowedError'
          ? 'Разрешите уведомления для сайта в настройках Chrome или Android.'
          : 'Не удалось изменить уведомления. Попробуйте ещё раз.');
      } finally {
        state.actionBusy = false;
        updateButton({ reveal: true });
      }
    });

    panel.appendChild(state.status);
    panel.appendChild(state.button);
    document.body.appendChild(panel);

    if (options && options.identity) saveIdentity(options.identity);
    updateButton({ reveal: true });
    recoverSubscription();
  }

  window.addEventListener('online', () => { state.recoveryAttempts = 0; recoverSubscription(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { state.recoveryAttempts = 0; recoverSubscription(); }
  });

  window.MedsiPush = {
    init,
    async getEnabled() { return isSupported() && wanted() !== 'no' && Notification.permission === 'granted' && !!(await getSubscription()); },
    async toggle() {
      const subscription = await getSubscription();
      if (subscription && wanted() !== 'no') { await unsubscribe(); return false; }
      await subscribe(); return wanted() !== 'no' && Notification.permission === 'granted' && !!(await getSubscription());
    },
    setIdentity: saveIdentity,
    clearIdentity,
    setPanelVisible: function (visible) {
      state.panelVisible = !!visible;
      if (!state.panelVisible) {
        setStatus('');
        hideButton();
        return;
      }
      updateButton({ reveal: true });
    },
    sendCurrentSubscription: async function () {
      const subscription = await getSubscription();
      if (subscription && wanted() !== 'no') return syncSubscription(subscription);
      return null;
    }
  };
})();
