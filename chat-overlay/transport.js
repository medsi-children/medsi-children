(function () {
  if(window.MedsiOverlayTransport)return;
  const BASE_URL = window.location.origin;
  const UPLOAD_URL = window.location.origin + '/chat-upload';
  const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
  const UPLOAD_TIMEOUT_MS = 90000;
  const READ_TIMEOUT_MS = 15000;
  const WRITE_TIMEOUT_MS = 35000;
  const READ_RETRIES = 2;
  const TRANSIENT_UPLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

  function requireSession(session) {
    if (!session || !session.token) throw new Error('Нет активной сессии чата.');
    if (Number(session.expiresAt || 0) && Number(session.expiresAt) <= Date.now() + 3000) {
      throw new Error('Сессия чата истекла. Откройте чат заново.');
    }
    return session;
  }

  function mediaUrl(fileId, driveSize) {
    const id = String(fileId || '');
    if (!id) return '';
    if (id.startsWith('s3:')) return BASE_URL + '/media/s3/' + encodeURIComponent(id.slice(3));
    // All existing KV/R2/Drive media must be moved into private S3 before cutover.
    // Never silently contact retired Workers or Google Drive with patient IDs.
    return BASE_URL + '/media/legacy-unavailable';
  }

  function mediaPreviewUrl(fileId, driveSize) {
    const id = String(fileId || '');
    const original = mediaUrl(id, driveSize);
    return id.startsWith('s3:') ? original + '?variant=preview' : original;
  }

  async function request(session, path, options, retryTransientWrite) {
    const provider = window.MedsiEducatorSession;
    const auth = provider ? {...await provider.get()} : session;
    try {
      return await requestAuthenticated(auth, path, options, retryTransientWrite);
    } catch (error) {
      if (!provider || error.status !== 401) throw error;
      // An explicit rejection happens before the operation. Renew once; never
      // turn network failures or permission denials into a login refresh loop.
      const renewed = await provider.renew(auth.token);
      return requestAuthenticated(renewed, path, options, retryTransientWrite);
    }
  }

  async function requestAuthenticated(session, path, options, retryTransientWrite) {
    const auth = requireSession(session);
    const method = String((options && options.method) || 'GET').toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD';
    const attempts = isWrite ? (retryTransientWrite ? 2 : 1) : READ_RETRIES + 1;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS) : null;
      try {
        const response = await fetch(BASE_URL + path, {
          cache: 'no-store',
          ...(options || {}),
          signal: controller ? controller.signal : undefined,
          headers: {
            ...((options && options.headers) || {}),
            'X-Medsi-Chat-Session': auth.token
          }
        });
        let payload;
        try { payload = await response.json(); }
        catch (_) {
          const error = new Error('Сервер чата вернул некорректный ответ.');
          error.code = 'BAD_RESPONSE';
          error.status = response.status;
          throw error;
        }
        if (!response.ok || !payload || !payload.ok) {
          const error = new Error((payload && payload.message) || 'Ошибка чата.');
          error.code = (payload && payload.code) || ('HTTP-' + response.status);
          error.status = response.status;
          // Do not retry an explicit authorization or business-rule response.
          if (response.status < 500 && response.status !== 408 && response.status !== 425 && response.status !== 429) throw error;
          throw error;
        }
        return payload;
      } catch (error) {
        if (controller && controller.signal.aborted) {
          lastError = Object.assign(new Error('Сервер чата отвечает слишком долго.'), {code:'TIMEOUT'});
        } else if (error && error.code) {
          lastError = error;
        } else {
          lastError = Object.assign(new Error((error && error.message) || 'Не удалось связаться с сервером чата.'), {code:'NETWORK'});
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
      if(lastError.status>=400&&lastError.status<500&&![408,425,429].includes(lastError.status))throw lastError;
      if(isWrite&&retryTransientWrite&&!['NETWORK','TIMEOUT','BAD_RESPONSE'].includes(lastError.code)&&
          ![408,425,429].includes(lastError.status)&&!(lastError.status>=500))throw lastError;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, (isWrite ? 700 : 350) * (attempt + 1)));
    }
    throw lastError || Object.assign(new Error('Не удалось связаться с сервером чата.'), {code:'NETWORK'});
  }

  function thread(session, phone, beforeKey, limit) {
    const path = '/lab/threads/' + encodeURIComponent(String(phone || '')) +
      '?before=' + encodeURIComponent(String(beforeKey || '')) +
      '&limit=' + encodeURIComponent(String(limit || 50));
    return request(session, path);
  }

  function chats(session, bucket) {
    return request(session, '/lab/chats?bucket=' + encodeURIComponent(String(bucket || 'all')));
  }

  function parents(session) {
    return request(session, '/lab/parents');
  }

  function normalizeEducatorText(text) {
    const source = String(text || '');
    const protectedText = /\b(?:https?:\/\/|www\.)[^\s]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    function normalizePlain(part) {
      const punctuation = part.replace(/([А-ЯЁа-яё]+)[ \t]*([,.])[ \t]*(?=[А-ЯЁа-яё]|\n|$)/g, (match, word, mark, offset, input) => {
        // Single-letter initials and abbreviations such as «т.д.» are ambiguous.
        if (mark === '.' && word.length === 1) return match;
        const next = input[offset + match.length];
        return word + mark + (next && next !== '\n' ? ' ' : '');
      });
      return punctuation.replace(/\([ \t]+/g, '(').replace(/[ \t]+\)/g, ')');
    }
    let result = '';
    let start = 0;
    for (const match of source.matchAll(protectedText)) {
      result += normalizePlain(source.slice(start, match.index)) + match[0];
      start = match.index + match[0].length;
    }
    return result + normalizePlain(source.slice(start));
  }

  function sendMessage(session, role, phone, message) {
    const payload = { ...(message || {}) };
    if (role === 'educator' && payload.type === 'text') payload.text = normalizeEducatorText(payload.text);
    if (!String(payload.clientMessageId || '').trim()) {
      payload.clientMessageId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }
    return request(session, '/lab/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, phone: String(phone || ''), side: String(role || '') })
    }, true);
  }

  function markRead(session, role, phone) {
    const path = role === 'educator'
      ? '/lab/read/' + encodeURIComponent(String(phone || ''))
      : '/lab/read-parent/' + encodeURIComponent(String(phone || ''));
    return request(session, path, { method: 'POST' });
  }

  function markUnread(session, phone) {
    return request(session, '/lab/unread/' + encodeURIComponent(String(phone || '')), { method: 'POST' });
  }

  function react(session, key, reaction) {
    return request(session, '/lab/reaction/' + encodeURIComponent(String(key || '')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reaction: String(reaction || '') })
    });
  }

  function edit(session, role, key, text) {
    return request(session, '/lab/edit/' + encodeURIComponent(String(key || '')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: String(role || ''), text: role === 'educator' ? normalizeEducatorText(text) : String(text || '') })
    });
  }

  function remove(session, role, key) {
    return request(session, '/lab/delete/' + encodeURIComponent(String(key || '')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: String(role || '') })
    });
  }

  function pin(session, phone, bucket) {
    return request(session, '/lab/pin/' + encodeURIComponent(String(phone || '')), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucket: String(bucket || '') })
    });
  }

  function makeUploadId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  }

  function isTransientUploadError(error) {
    if (!error) return false;
    if (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'SESSION_CHECK_UNAVAILABLE') return true;
    return TRANSIENT_UPLOAD_STATUSES.has(Number(error.status || 0));
  }

  async function uploadAttempt(auth, phone, file, uploadId) {
    let response;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS) : null;
    try {
      response = await fetch(UPLOAD_URL, {
        method: 'POST',
        body: file,
        signal: controller ? controller.signal : undefined,
        headers: {
          'X-Medsi-Upload-Id': uploadId,
          'X-Medsi-Chat-Session': auth.token,
          'X-Medsi-Phone': String(phone || ''),
          'X-File-Name': encodeURIComponent(String((file && file.name) || 'attachment')),
          'content-type': String((file && file.type) || 'application/octet-stream')
        }
      });
    } catch (error) {
      const timedOut = !!(controller && controller.signal.aborted);
      const wrapped = new Error(timedOut
        ? 'Загрузка заняла слишком много времени. Проверьте интернет и попробуйте ещё раз.'
        : ((error && error.message) || 'Не удалось загрузить файл.'));
      wrapped.code = timedOut ? 'TIMEOUT' : 'NETWORK';
      throw wrapped;
    } finally {
      if (timer) clearTimeout(timer);
    }

    let payload;
    try { payload = await response.json(); }
    catch (_) {
      const error = new Error('Сервер загрузки вернул некорректный ответ.');
      error.code = 'BAD_RESPONSE';
      error.status = response.status;
      throw error;
    }

    if (!response.ok || !payload || !payload.ok) {
      const error = new Error((payload && payload.message) || 'Не удалось загрузить файл.');
      error.code = (payload && payload.code) || ('HTTP-' + response.status);
      error.status = response.status;
      throw error;
    }

    return { ...payload, url: BASE_URL + String(payload.url || '') };
  }

  async function upload(session, phone, file) {
    let auth = requireSession(window.MedsiEducatorSession ? await window.MedsiEducatorSession.get() : session);
    if (file && Number(file.size || 0) > MAX_UPLOAD_BYTES) {
      const error = new Error('Размер файла не должен превышать 100 МБ.');
      error.code = 'FILE_TOO_LARGE';
      throw error;
    }
    const uploadId = makeUploadId();

    try {
      return await uploadAttempt(auth, phone, file, uploadId);
    } catch (error) {
      if (error.status === 401 && window.MedsiEducatorSession) {
        auth = requireSession(await window.MedsiEducatorSession.renew(auth.token));
        return uploadAttempt(auth, phone, file, uploadId);
      }
      if (!isTransientUploadError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 700));
      return uploadAttempt(auth, phone, file, uploadId);
    }
  }

  function reportSubmit(session, payload) {
    return request(session, '/lab/report-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    }, true);
  }

  function reportStatus(session, submissionId) {
    return request(session, '/lab/report-submit/status?submissionId=' + encodeURIComponent(String(submissionId || '')));
  }

  function parentDelete(session, payload) {
    return request(session, '/lab/parent-delete', {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(payload || {})
    }, true);
  }

  function parentDeleteStatus(session, operationId) {
    return request(session, '/lab/parent-delete/status?operationId=' + encodeURIComponent(String(operationId || '')));
  }

  function parentDeletePending(session) {
    return request(session, '/lab/parent-delete/pending');
  }

  function retryParentDelete(session, operationId) {
    return request(session, '/lab/parent-delete/retry', {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({operationId:String(operationId || '')})
    }, true);
  }

  function injectVideoStyles() {
    if (document.getElementById('medsi-video-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'medsi-video-ui-style';
    style.textContent = `
      #btnVideo{display:none!important}
      .medsi-video-frame{position:relative!important;overflow:hidden}
      .medsi-video-frame video{display:block;width:100%;height:auto;background:#dfeff0}
      .medsi-video-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:68px;height:68px;border:0;border-radius:50%;background:#16bfc5;box-shadow:0 8px 24px rgba(0,79,84,.22);display:grid;place-items:center;cursor:pointer;z-index:3;padding:0}
      .medsi-video-play::before{content:'';display:block;margin-left:5px;width:0;height:0;border-top:14px solid transparent;border-bottom:14px solid transparent;border-left:22px solid #fff}
      .medsi-video-frame.is-playing .medsi-video-play{opacity:0;pointer-events:none}
      .medsi-video-play:focus-visible{outline:3px solid rgba(22,191,197,.35);outline-offset:3px}
    `;
    document.head.appendChild(style);
  }


  function enhanceVideo(video) {
    if (!video || video.dataset.medsiVideoEnhanced === '1') return;
    video.dataset.medsiVideoEnhanced = '1';
    video.playsInline = true;
    video.preload = 'metadata';
    const frame = video.parentElement;
    if (!frame) return;
    frame.classList.add('medsi-video-frame');
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'medsi-video-play';
    play.setAttribute('aria-label', 'Воспроизвести видео');
    frame.appendChild(play);
    const sync = () => frame.classList.toggle('is-playing', !video.paused && !video.ended);
    video.addEventListener('play', sync);
    video.addEventListener('playing', sync);
    video.addEventListener('pause', sync);
    video.addEventListener('ended', sync);
    video.addEventListener('loadedmetadata', () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.paused) return;
      const target = Math.min(1, Math.max(0, video.duration - 0.05));
      if (target > 0.05 && video.currentTime < 0.05) {
        try { video.currentTime = target; } catch (_) {}
      }
    }, { once: true });
    play.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      try { await video.play(); } catch (_) {}
    });
    sync();
  }

  function enhanceMediaNode(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches('img,video')) repairS3Source(node);
    if (node.matches && node.matches('video')) enhanceVideo(node);
    if (node.querySelectorAll) {
      node.querySelectorAll('img,video').forEach(repairS3Source);
      node.querySelectorAll('video').forEach(enhanceVideo);
    }
  }

  function videoFramePreview(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      const done = value => { URL.revokeObjectURL(url); resolve(value); };
      video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('preview')); };
      video.onloadedmetadata = () => {
        const target = Math.min(1, Math.max(0, Number(video.duration || 0) - 0.05));
        if (target <= 0.05) {
          video.currentTime = 0;
        } else {
          try { video.currentTime = target; } catch (_) {}
        }
      };
      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas');
          const scale = Math.min(1, 720 / Math.max(1, video.videoWidth));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          done(canvas.toDataURL('image/jpeg', 0.82));
        } catch (error) { URL.revokeObjectURL(url); reject(error); }
      };
      video.src = url;
    });
  }

  function installMediaUi() {
    injectVideoStyles();
    document.querySelectorAll('img,video').forEach(repairS3Source);
    document.querySelectorAll('video').forEach(enhanceVideo);
    const observer = new MutationObserver(records => {
      records.forEach(record => record.addedNodes.forEach(enhanceMediaNode));
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('change', event => {
      const input = event.target;
      if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return;
      const file = input.files && input.files[0];
      if (!file || !/^video\//i.test(file.type)) return;
      videoFramePreview(file).then(dataUrl => {
        const preview = document.querySelector('#chatImagePreview img, .chat-image-preview img');
        if (preview && !preview.closest('.hidden')) preview.src = dataUrl;
      }).catch(() => {});
    }, true);
  }

  window.MedsiOverlayTransport = {
    baseUrl: BASE_URL,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    mediaUrl,
    mediaPreviewUrl,
    request,
    thread,
    chats,
    parents,
    normalizeEducatorText,
    sendMessage,
    markRead,
    markUnread,
    react,
    edit,
    remove,
    pin,
    upload,
    reportSubmit,
    reportStatus,
    parentDelete,
    parentDeleteStatus,
    parentDeletePending,
    retryParentDelete
  };

  installMediaUi();
})();
