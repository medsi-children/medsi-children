/** ========= НАСТРОЙКИ ========= **/
const SPREADSHEET_ID_PROPERTY = 'MEDSI_SPREADSHEET_ID';
const DATA_SHEET_NAME         = 'REPORTS';

const SHEET_MORNING           = 'MORNING';
const SHEET_EVENING           = 'EVENING';
const SHEET_PSYCHOLOGY        = 'PSYCHOLOGY';
const DATABASE_SHEET_NAME     = 'DATABASE';
const CHAT_PHOTOS_FOLDER_NAME = 'MEDSI_CHAT_PHOTOS';
const PUSH_WORKER_URL_FALLBACK = 'https://medsi-push-worker.medsi-children.workers.dev/notify';
const PUSH_WORKER_SECRET_PROPERTY = 'MEDSI_CHAT_PUSH_SECRET';

/** ========= БАЗОВЫЕ HELPERS ========= **/
function getRequiredScriptProperty_(propertyName) {
  const value = String(PropertiesService.getScriptProperties().getProperty(propertyName) || '').trim();
  if (!value) throw new Error('Не настроено обязательное свойство скрипта: ' + propertyName);
  return value;
}

function getSpreadsheetId_() {
  return getRequiredScriptProperty_(SPREADSHEET_ID_PROPERTY);
}

function getWorkerSharedSecret_() {
  return getRequiredScriptProperty_(PUSH_WORKER_SECRET_PROPERTY);
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(getSpreadsheetId_());
}

function getSheet_(name) {
  const ss = getSpreadsheet_();
  return ss.getSheetByName(name);
}

function getDataSheet_() {
  return getSheet_(DATA_SHEET_NAME);
}


function buildProfileFromReportRow_(r) {
  const parentName = String(r[1] || '').trim();
  const childC     = String(r[2] || '').trim();
  const famD       = String(r[3] || '').trim();

  const childBase = stripInitialFromName_(childC) || childC;
  const childName = [childBase, famD].filter(Boolean).join(' ').trim();

  return {
    phone: normalizePhone_(r[0]),
    parentName,
    childName,
    childAdmissionId: String(r[7] || '').trim(),
    profileGeneration: String(r[8] || '').trim()
  };
}

function getReportRowsByPhone_(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return [];

  const sh = getDataSheet_();
  if (!sh) return [];

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const values = sh.getRange(2, 1, lastRow - 1, 8).getValues(); // A:H, including child-admission ID
  return values.filter(r => last10_(r[0]) === phone10);
}

/** ========= ВЭБ-апп ========= **/
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getChatBackendConfig() {
  return { ok: true, backend: 'd1' };
}

function getD1ChatSession(roleRaw, phoneRaw, tutorTokenRaw) {
  const role = String(roleRaw || '').trim().toLowerCase();
  const phone10 = last10_(phoneRaw);

  if (role === 'educator') {
    requireTutorSession_(tutorTokenRaw);
  } else if (role === 'parent') {
    if (!phone10 || !isPhoneActiveInReports_(phone10)) {
      throw new Error('Чат недоступен.');
    }

    requireParentAccess_(phone10, tutorTokenRaw);

    // D1 mirrors are warmed on this chat-specific request.  Keep the parent
    // registration response independent of Cloudflare availability/latency.
    try { syncD1ProfileForPhone_(phone10); }
    catch (e) { Logger.log('D1 profile refresh deferred: ' + String(e && e.message || e)); }
  } else {
    throw new Error('Некорректная роль.');
  }

  return createD1ChatSession_(role, phone10);
}

// Android fallback for the educator chat list.  This is deliberately a
// server-to-server proxy to the same Cloudflare D1 Worker, never a read from
// the legacy Messages / Chat index sheets.  It is used only when a device's
// WebView cannot reach workers.dev directly.
function listD1ChatsForEducator(tutorTokenRaw, bucketRaw) {
  requireTutorSession_(tutorTokenRaw);
  const bucket = String(bucketRaw || 'all').trim().toLowerCase();
  if (!['all', 'unread', 'read'].includes(bucket)) throw new Error('Некорректная группа чатов.');
  const session = createD1ChatSession_('educator', '');
  const response = UrlFetchApp.fetch(
    'https://medsi-chat-worker.medsi-children.workers.dev/lab/chats?bucket=' + encodeURIComponent(bucket),
    {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'X-Medsi-Chat-Session': session.token }
    }
  );
  const value = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !value.ok) {
    throw new Error(value.message || 'Не удалось получить список чатов из Cloudflare.');
  }
  return value;
}

// Fallback exclusively for the educator panel on browsers that leave a
// direct cross-origin Worker thread request pending.  This reads the same D1
// Worker endpoint as the normal fast path; it does not access Messages or
// Chat index in Google Sheets.
function getD1ThreadForEducator(phoneRaw, tutorTokenRaw, beforeKeyRaw, limitRaw) {
  requireTutorSession_(tutorTokenRaw);
  const phone = last10_(phoneRaw);
  if (!phone) throw new Error('Некорректный номер чата.');
  const beforeKey = String(beforeKeyRaw || '').trim();
  const requestedLimit = Number(limitRaw) || 50;
  const limit = Math.max(1, Math.min(150, requestedLimit));
  const session = createD1ChatSession_('educator', '');
  const response = UrlFetchApp.fetch(
    'https://medsi-chat-worker.medsi-children.workers.dev/lab/threads/' + encodeURIComponent(phone) +
      '?before=' + encodeURIComponent(beforeKey) + '&limit=' + encodeURIComponent(limit),
    {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'X-Medsi-Chat-Session': session.token }
    }
  );
  const value = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !value.ok) {
    throw new Error(value.message || 'Не удалось получить историю чата из Cloudflare.');
  }
  return value;
}


function getD1MediaForEducator(fileIdRaw, tutorTokenRaw) {
  requireTutorSession_(tutorTokenRaw);

  const fileId = String(fileIdRaw || '').trim();
  if (!fileId) throw new Error('Некорректный идентификатор вложения.');

  if (!fileId.startsWith('kv:')) {
    throw new Error('Fallback поддерживает только Cloudflare KV-вложения.');
  }

  const key = fileId.slice(3);
  if (!key || key.indexOf('..') !== -1) {
    throw new Error('Некорректный идентификатор вложения.');
  }

  const scheme = 'https';
  const host = 'medsi-chat-worker.medsi-children.workers.dev';
  const mediaUrl = scheme + '://' + host + '/media/' + encodeURIComponent(key);

  const response = UrlFetchApp.fetch(mediaUrl, {
    method: 'get',
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Не удалось получить вложение из Cloudflare. HTTP ' + code);
  }

  const blob = response.getBlob();
  const contentType = String(
    blob.getContentType() ||
    response.getHeaders()['Content-Type'] ||
    'application/octet-stream'
  );

  const bytes = blob.getBytes();

  return {
    ok: true,
    fileId: fileId,
    contentType: contentType,
    size: bytes.length,
    dataUrl: 'data:' + contentType + ';base64,' + Utilities.base64Encode(bytes)
  };
}

function sendD1MessageForEducator(phoneRaw, messageRaw, tutorTokenRaw) {
  requireTutorSession_(tutorTokenRaw);

  const phone = last10_(phoneRaw);
  if (!phone || !isPhoneActiveInReports_(phone)) {
    return { ok:false, message:'Диалог с родителем был закрыт.' };
  }

  const session = createD1ChatSession_('educator', '');
  const message = messageRaw || {};

  const response = UrlFetchApp.fetch(
    'https://medsi-chat-worker.medsi-children.workers.dev/lab/messages',
    {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        'X-Medsi-Chat-Session': session.token
      },
      payload: JSON.stringify({
        phone: phone,
        side: 'educator',
        type: String(message.type || 'text'),
        text: String(message.text || ''),
        fileId: String(message.fileId || ''),
        replyToKey: String(message.replyToKey || '')
      })
    }
  );

  const value = JSON.parse(response.getContentText() || '{}');

  if (
    response.getResponseCode() < 200 ||
    response.getResponseCode() >= 300 ||
    !value.ok
  ) {
    throw new Error(value.message || 'D1 HTTP ' + response.getResponseCode());
  }

  return value;
}


// Emergency parent fallback for networks that cannot reach workers.dev
// directly. Messages still live exclusively in Cloudflare D1.
function getD1ThreadForParent(phoneRaw, beforeKeyRaw, limitRaw, parentSessionRaw) {
  requireParentAccess_(phoneRaw, parentSessionRaw);
  const phone = last10_(phoneRaw);
  if (!phone || !isPhoneActiveInReports_(phone)) {
    throw new Error('Чат недоступен.');
  }

  const beforeKey = String(beforeKeyRaw || '').trim();
  const requestedLimit = Number(limitRaw) || 50;
  const limit = Math.max(1, Math.min(150, requestedLimit));
  const session = createD1ChatSession_('parent', phone);
  const chatBase = 'https' + '://' + 'medsi-chat-worker.medsi-children.workers.dev';

  const response = UrlFetchApp.fetch(
    chatBase + '/lab/threads/' + encodeURIComponent(phone) +
      '?before=' + encodeURIComponent(beforeKey) +
      '&limit=' + encodeURIComponent(limit),
    {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'X-Medsi-Chat-Session': session.token }
    }
  );

  const value = JSON.parse(response.getContentText() || '{}');
  if (
    response.getResponseCode() < 200 ||
    response.getResponseCode() >= 300 ||
    !value.ok
  ) {
    throw new Error(value.message || 'Не удалось получить историю чата из Cloudflare.');
  }

  return value;
}

function d1ParentWorkerRequest_(phoneRaw, path, method, payload) {
  const phone = last10_(phoneRaw);
  if (!phone) throw new Error('Некорректный номер родительской D1-сессии.');
  const session = createD1ChatSession_('parent', phone);
  const response = UrlFetchApp.fetch(
    'https://medsi-chat-worker.medsi-children.workers.dev' + path,
    {
      method: method || 'get',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'X-Medsi-Chat-Session': session.token },
      payload: payload ? JSON.stringify(payload) : undefined
    }
  );
  const value = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !value.ok) {
    throw new Error(value.message || 'D1 HTTP ' + response.getResponseCode());
  }
  return value;
}

function getD1ParentUnreadState_(phoneRaw) {
  return d1ParentWorkerRequest_(phoneRaw, '/lab/parent-unread', 'get');
}

function markD1ParentReportRead_(phoneRaw, kind, version) {
  return d1ParentWorkerRequest_(phoneRaw, '/lab/report-read', 'post', { kind:kind, version:version });
}

function getD1ParentReportUnread_(phoneRaw) {
  return d1ParentWorkerRequest_(phoneRaw, '/lab/parent-unread', 'get');
}

function d1EducatorWorkerRequest_(path, method, payload) {
  const session = createD1ChatSession_('educator', '');
  const response = UrlFetchApp.fetch('https://medsi-chat-worker.medsi-children.workers.dev' + path, {
    method:method || 'get', contentType:'application/json', muteHttpExceptions:true,
    headers:{'X-Medsi-Chat-Session':session.token}, payload:payload ? JSON.stringify(payload) : undefined
  });
  const value = JSON.parse(response.getContentText() || '{}');
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !value.ok) throw new Error(value.message || 'D1 HTTP ' + response.getResponseCode());
  return value;
}

function markD1ParentMessagesRead_(phoneRaw) {
  const phone = last10_(phoneRaw);
  return d1ParentWorkerRequest_(phone, '/lab/read-parent/' + encodeURIComponent(phone), 'post');
}

function sendD1MessageForParent(phoneRaw, messageRaw, parentSessionRaw) {
  requireParentAccess_(phoneRaw, parentSessionRaw);
  const phone = last10_(phoneRaw);
  if (!phone || !isPhoneActiveInReports_(phone)) {
    return { ok:false, code:'CHAT_CLOSED', message:'Чат недоступен.' };
  }

  const session = createD1ChatSession_('parent', phone);
  const message = messageRaw || {};
  const chatBase = 'https' + '://' + 'medsi-chat-worker.medsi-children.workers.dev';

  const response = UrlFetchApp.fetch(
    chatBase + '/lab/messages',
    {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: { 'X-Medsi-Chat-Session': session.token },
      payload: JSON.stringify({
        phone: phone,
        side: 'parent',
        type: String(message.type || 'text'),
        text: String(message.text || ''),
        fileId: String(message.fileId || ''),
        replyToKey: String(message.replyToKey || '')
      })
    }
  );

  const value = JSON.parse(response.getContentText() || '{}');
  if (
    response.getResponseCode() < 200 ||
    response.getResponseCode() >= 300 ||
    !value.ok
  ) {
    throw new Error(value.message || 'D1 HTTP ' + response.getResponseCode());
  }

  return value;
}

// Creates only the short-lived Worker token.  All access checks remain in the
// public entry points above; this helper also lets a successful tutor login
// piggyback the D1 session on the same Apps Script response.
function createD1ChatSession_(role, phoneRaw) {
  const secret = String(PropertiesService.getScriptProperties().getProperty('D1_SESSION_SECRET') || getWorkerSharedSecret_() || '');
  if (!secret) throw new Error('Сессии D1 не настроены.');

  const phone10 = role === 'parent' ? last10_(phoneRaw) : '';
  if (role === 'parent' && !phone10) {
    throw new Error('Некорректный номер родительской D1-сессии.');
  }

  // Educators should be able to open the panel for years without a renewal
  // request. Parent identity is always canonical PHONE10.
  const sessionDays = role === 'educator' ? 5 * 365 : 30;
  const exp = Date.now() + sessionDays * 24 * 60 * 60 * 1000;
  const payload = Utilities.base64EncodeWebSafe(
    JSON.stringify({ role:role, phone10:phone10, exp:exp })
  ).replace(/=+$/g, '');
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payload, secret)
  ).replace(/=+$/g, '');

  return { ok:true, token:payload + '.' + signature, expiresAt:exp };
}

function retiredLegacyUiPage_() {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Старая панель больше не используется</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f7fbfc;color:#11424a;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;text-align:center"><main><h1 style="margin:0 0 12px">Эта старая страница больше не используется</h1><p style="margin:0;color:#5f7f86">Откройте Медси Бот по привычной ссылке. Серверные функции Apps Script продолжают работать.</p></main></body></html>'
  ).setTitle('Старая панель больше не используется');
}

function doGet(e) {
  if (e && e.parameter && e.parameter.debugPush === '1') {
    const debugResult = sendPushDebugEvent_({
      role: 'appscript-debug',
      phone: e.parameter.phone || '',
      title: 'doGet debugPush',
      body: 'AppScript reached Cloudflare from doGet'
    });

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, debugPush: true, debugResult }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return retiredLegacyUiPage_();
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents
      ? String(e.postData.contents || '')
      : '{}';
    const payload = JSON.parse(raw || '{}');
    const action = String(payload.action || '').trim();

    // One narrowly scoped server-to-server migration control. It is protected
    // by the existing private server secret and can never be called by UI code.
    if (action === 'reportHistoryCapture' || action === 'd1ReportCurrentSync' || action === 'd1ProfileReconcile' || action === 'd1ProfileAudit' || action === 'reportQueueProcess' || action === 'parentDeletionQueueProcess') {
      if (String(payload.authorization || '') !== getWorkerSharedSecret_()) {
        return ContentService.createTextOutput(JSON.stringify({ ok:false, message:'Unauthorized' }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      let result;
      if (action === 'd1ReportCurrentSync') result = syncD1CurrentReportsToWorker();
      else if (action === 'd1ProfileReconcile') result = syncD1ProfilesFromReports();
      else if (action === 'd1ProfileAudit') result = auditReportsD1Profiles();
      else if (action === 'reportQueueProcess') result = appendReportFromWorker_(payload.param || {});
      else if (action === 'parentDeletionQueueProcess') result = processParentDeletionFromCloudflare_(payload.param || {});
      else {
        result = captureScheduledReportHistory();
      }
      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'api') {
      return ContentService
        .createTextOutput(JSON.stringify(handleApiRequest_(payload)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, message: 'Unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, message: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Browser-facing entry points only. Trigger/internal maintenance functions
// stay callable inside the project, never through the anonymous HTTP bridge.
function getApiMethodMap_() {
  const methods = Object.assign(Object.create(null), {
    verifyTutorAccess, verifyTutorSession, checkPhoneExists,
    testCheckRegistrationState, getParentProfileByPhone, getParentBootstrap,
    verifyParentSession, getParentRegistrationStatus,
    listPendingParentReauthorizations, decideParentReauthorization,
    mirrorCloudflareParentRegistration,
    getD1ChatSession, listD1ChatsForEducator, getD1ThreadForEducator,
    getD1MediaForEducator, sendD1MessageForEducator,
    getD1ThreadForParent, sendD1MessageForParent,
    registerParent, getReportFor, getPsychologyReportFor,
    appendReport, getReportSubmissionStatus,
    testAppendReportToTestSheet, testValidateAndWriteReport,
    getReportChildDeletionPreview, deleteReportChildByPhone,
    getReportInactivityReminder, acknowledgeReportInactivityReminder,
    getParentUnreadState, markReportAsRead,
    sendParentChatMessage, sendEducatorChatMessage,
    listAvailableParentsForChat, markEducatorMessagesAsRead
  });
  // Cached clients must fail explicitly rather than reading/writing a second
  // chat database. All current panels use the D1 transport instead.
  [
    'getAllChatMessages', 'listParentChats', 'listUnreadParentChats',
    'listReadParentChats', 'hasUnreadParentChats', 'getChatMessages',
    'getParentChatMessages', 'getOlderParentChatMessages', 'getOlderChatMessages',
    'setChatMessageReaction', 'deleteMessage', 'updateMessage',
    'deleteChatMessage', 'editChatMessage', 'setEducatorChatPin',
    'uploadEducatorChatImage', 'uploadEducatorVideoThumbnail',
    'sendEducatorVideoMessage', 'uploadParentChatImage',
    'uploadChatAttachmentForD1', 'notifyD1ChatMessage',
    'markParentMessagesAsReadByEducator', 'markParentMessagesAsUnreadByEducator'
  ].forEach(function(name) { methods[name] = retiredLegacyChatApi_; });
  return methods;
}

function retiredLegacyChatApi_() {
  return { ok:false, code:'LEGACY_CHAT_RETIRED',
    message:'Старая версия чата больше не используется. Откройте Медси Бот заново.' };
}

function handleApiRequest_(payload) {
  try {
    const method = String(payload && payload.method || '').trim();
    const args = Array.isArray(payload && payload.args) ? payload.args : [];
    const previewToken = args.find(function(value) { return typeof value === 'string' && value.split('.').length === 2 && value.length > 100; });
    if (previewToken) {
      const phone = args.find(function(value) { return /^\+?[0-9 ()-]{10,}$/.test(String(value || '')); });
      const claims = phone ? decodeCloudflareParentSession_(phone, previewToken) : null;
      if (claims && claims.preview === true && !['getParentProfileByPhone','getReportFor','getPsychologyReportFor','getParentUnreadState'].includes(method)) {
        return {ok:false,message:'Предварительный просмотр доступен только для чтения.'};
      }
    }
    const methods = getApiMethodMap_();
    const fn = methods[method];

    if (!method || !Object.prototype.hasOwnProperty.call(methods, method) || typeof fn !== 'function') {
      return {
        ok: false,
        message: 'Unknown API method: ' + method
      };
    }

    return {
      ok: true,
      result: fn.apply(null, args)
    };
  } catch (err) {
    return {
      ok: false,
      message: String(err && err.message || err),
      stack: String(err && err.stack || '')
    };
  }
}

function checkPhoneExists(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return { ok: false };

  const sh = getDataSheet_();
  if (!sh) return { ok: false };

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false };

  const phones = sh.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  const exists = phones.some(p => last10_(p) === phone10);

  return { ok: exists };
}

function secureTextEqual_(leftRaw, rightRaw) {
  const left = String(leftRaw || '');
  const right = String(rightRaw || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function isParentSessionValid_(phoneRaw, tokenRaw) {
  const token = String(tokenRaw || '').trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  try {
    const claims = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    const matchingPhone = last10_(claims.phone10) === last10_(phoneRaw);
    const cloudflareClaim = claims.role === 'parent' && Number(claims.exp) > Date.now();
    if (!matchingPhone) return false;

    // New Cloudflare sessions are checked locally and never enter the old
    // compatibility lookup, so their request path stays fast.
    if (cloudflareClaim) {
      let d1Secret = String(PropertiesService.getScriptProperties().getProperty('D1_SESSION_SECRET') || '');
      if (!d1Secret) {
        try { d1Secret = getWorkerSharedSecret_(); } catch (_) {}
      }
      if (!d1Secret) return false;
      const d1Signature = Utilities.base64EncodeWebSafe(
        Utilities.computeHmacSha256Signature(parts[0], d1Secret)
      ).replace(/=+$/g, '');
      return secureTextEqual_(parts[1], d1Signature);
    }

    return false;
  } catch (_) {
    return false;
  }
}

function requireParentAccess_(phoneRaw, tokenRaw) {
  if (!isParentSessionValid_(phoneRaw, tokenRaw)) {
    throw new Error('Требуется войти в аккаунт.');
  }
  return { ok: true };
}

function verifyParentSession(phoneRaw, parentSessionRaw) {
  try {
    const phone10 = last10_(phoneRaw);
    if (!phone10 || !isPhoneActiveInReports_(phone10)) return { ok: false, message: 'Чат недоступен.' };
    requireParentAccess_(phone10, parentSessionRaw);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) };
  }
}

function buildParentBootstrap_(profile, parentSession) {
  // Legacy bootstrap callers may arrive before the periodic REPORTS -> D1
  // reconciliation. Warm the profile before asking D1 for chat state so the
  // unread badge does not become a false negative during that short window.
  try { syncD1ProfileForPhone_(profile.phone); }
  catch (e) { Logger.log('D1 profile bootstrap refresh deferred: ' + String(e && e.message || e)); }
  const unreadRes = hasUnreadEducatorMessages(profile.phone);
  let d1Session = null;
  try { d1Session = createD1ChatSession_('parent', profile.phone); } catch (e) { Logger.log('D1 session piggyback unavailable: ' + String(e && e.message || e)); }
  return {
    ok: true,
    phone: profile.phone,
    parentName: profile.parentName || '',
    childName: profile.childName || '',
    hasUnread: !!(unreadRes && unreadRes.ok && unreadRes.hasUnread),
    reportUnread: getReportUnreadStatus_(profile.phone),
    parentSession: parentSession || '',
    d1Session: d1Session
  };
}

/**
 * Быстрый профиль по номеру — для фронта, чтобы не тянуть весь список родителей.
 */
function getParentProfileByPhone(phoneRaw, parentSessionRaw) {
  try {
    requireParentAccess_(phoneRaw, parentSessionRaw);
const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Ваш номер не найден в системе.' };
    }

    return {
      ok: true,
      phone: profile.phone,
      parentName: profile.parentName || '',
      childName: profile.childName || ''};
  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки профиля: ' + (e.message || e) };
  }
}

/**
 * Один компактный стартовый запрос:
 * профиль + непрочитанные сообщения.
 */
function getParentBootstrap(phoneRaw, parentSessionRaw) {
  try {
const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Ваш номер не найден в системе.' };
    }

    requireParentAccess_(profile.phone, parentSessionRaw);
    return buildParentBootstrap_(profile, String(parentSessionRaw || ''));
  } catch (e) {
    return { ok: false, message: 'Ошибка стартовой загрузки: ' + (e.message || e) };
  }
}

/** ========= ПОДДЕРЖКА СПРАВОЧНИКА ИМЁН ========= **/
function addNameVariantRow_(dict, canon, canonRaw, variantsRaw) {
  const canonKey = normalizeName_(canonRaw);
  if (!canonKey) return;

  const variants = String(variantsRaw || '')
    .split(',')
    .map(v => normalizeName_(v))
    .filter(Boolean);

  const all = new Set(dict[canonKey] || []);
  all.add(canonKey);
  variants.forEach(v => all.add(v));

  dict[canonKey] = Array.from(all);
  all.forEach(v => { canon[v] = canonKey; });
}


// Do not access SpreadsheetApp while Apps Script is initializing globals.
// Simple triggers (such as onEdit) cannot call openById; load the shared
// variants only when a name-matching helper actually needs them.
let NAME_DATA = null;
let NAME_EQUIVALENTS = {};
let CANON_NAME_MAP = {};
let PREFERRED_NAME_MAP = {};


function isInNameBase(nameNorm) {
  if (!nameNorm) return false;
  ensureNameEquivalentsLoaded_();
  const canonKey = (CANON_NAME_MAP && CANON_NAME_MAP[nameNorm]) ? CANON_NAME_MAP[nameNorm] : nameNorm;
  return !!NAME_EQUIVALENTS && Object.prototype.hasOwnProperty.call(NAME_EQUIVALENTS, canonKey);
}

function isSurnameLike(wordNorm) {
  return /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|енко|чук|щук|юк|ко|дзе|швили|оглы|кызы|ули|ян|янц|яну|чян)$/.test(wordNorm);
}

/** 🧠 Умный разбор имени и фамилии */
function splitNameSmart(fullNameRaw) {
  const raw = String(fullNameRaw || '').trim();
  if (!raw) return { first: '', last: '' };

  const parts = raw
    .split(/\s+/)
    .map(p => p.replace(/[^А-Яа-яЁёA-Za-z\-]/g, '').trim())
    .filter(Boolean);

  if (parts.length === 1) {
    const first = capWord(parts[0]);
    return { first, last: '' };
  }

  const aRaw = parts[0];
  const bRaw = parts[1];
  const a = normRu(aRaw);
  const b = normRu(bRaw);

  const aInBase = isInNameBase(a);
  const bInBase = isInNameBase(b);
  const aLooksS = isSurnameLike(a);
  const bLooksS = isSurnameLike(b);

  if (aInBase && !bInBase) {
    return { first: capWord(aRaw), last: capWord(bRaw) };
  }

  if (!aInBase && bInBase) {
    return { first: capWord(bRaw), last: capWord(aRaw) };
  }

  if (!aInBase && !bInBase) {
    if (aLooksS && !bLooksS) return { first: capWord(bRaw), last: capWord(aRaw) };
    if (!aLooksS && bLooksS) return { first: capWord(aRaw), last: capWord(bRaw) };
    return { first: capWord(aRaw), last: capWord(bRaw) };
  }

  if (aInBase && bInBase) {
    return { first: capWord(aRaw), last: '' };
  }

  return { first: capWord(aRaw), last: capWord(bRaw) };
}

/** ========= Регистрация родителя ========= **/
function registerParent(parentNameRaw, childNameRaw, phoneRaw, registrationAttemptIdRaw) {
  // Compatibility for cached clients. Cloudflare is the registration writer;
  // REPORTS is filled from the D1 outbox and remains manually editable.
  return registerParentInCloudflare_(parentNameRaw, childNameRaw, phoneRaw, registrationAttemptIdRaw);
}

function smartRegisterFromInboxCore_(phoneRaw, parentNameRaw, childNameRaw, deferD1Sync, profileGenerationRaw) {
  const phone = normalizePhone_(phoneRaw);
  const p = splitNameSmart(parentNameRaw);
  const c = splitNameSmart(childNameRaw);

  const parentFirst = p.first || '';
  const parentLast  = p.last  || '';
  const childFirst  = c.first || '';
  const childLast   = c.last  || '';

  if (!phone || !parentFirst || !childFirst) return;

  const sh = getDataSheet_();
  if (!sh) throw new Error(`Нет листа "${DATA_SHEET_NAME}"`);
  const profileGeneration = String(profileGenerationRaw || '').trim();
  ensureReportParentGenerationColumn_(sh);

  const lastRow = sh.getLastRow();
  const data = lastRow > 1
    ? sh.getRange(2, 1, lastRow - 1, 1).getValues().flat()
    : [];

  const phone10 = last10_(phone);
  if (data.some(p => last10_(p) === phone10)) return;

  // New forms require a child's surname. Older cached clients can omit it:
  // infer the grammatical form from the child's first name in that case only.
  const familyForStore = childLast || inheritedChildFamily_(childFirst, parentLast);

  // A repeated admission with the same contact starts a new ownership epoch.
  const admissionKey = 'REPORT_ADMISSION_' + phone10;
  const admissionToken = Utilities.getUuid();
  const childAdmissionId = reportAdmissionIdForNewChild_(sh, childFirst, familyForStore);
  PropertiesService.getScriptProperties().setProperty(admissionKey, admissionToken);
  cacheRawReportOwnershipProperty_(admissionKey, admissionToken);
  sh.appendRow([
    phone,
    parentFirst,
    childFirst,
    familyForStore,
    '',
    '',
    defaultParentRelationship_(parentFirst),
    childAdmissionId,
    profileGeneration
  ]);

  appendToDatabase_(phone, parentFirst, childFirst, familyForStore);

  // Google Contacts не синхронизируем внутри регистрации:
  // полный sync может занимать много секунд и не должен задерживать
  // успешный ответ новому родителю. Для Contacts уже есть часовой trigger.
  // REPORTS остаётся источником истины.
  // This is the REPORTS projection of a Cloudflare registration. The outbox
  // coordinates retries; an optional direct D1 refresh is compatibility only.
  try {
    if (!deferD1Sync) syncD1ProfileForPhone_(phone);
  } catch (d1Err) {
    Logger.log(
      'D1 profile sync after registration failed for ' +
      last10_(phone) + ': ' +
      String(d1Err && d1Err.message || d1Err)
    );
  }
}


function testCheckRegistrationState(phoneRaw, tutorTokenRaw) {
  requireTutorSession_(tutorTokenRaw);

  const phone10 = last10_(phoneRaw);
  if (!phone10) {
    return {
      ok: false,
      message: 'Некорректный номер.'
    };
  }

  const reportRows = getReportRowsByPhone_(phone10);

  const db = getDatabaseSheet_();
  let databaseRows = [];

  if (db && db.getLastRow() >= 2) {
    const values = db
      .getRange(2, 1, db.getLastRow() - 1, 4)
      .getValues();

    databaseRows = values.filter(
      row => last10_(row[0]) === phone10
    );
  }

  const reportProfile = reportRows.length
    ? buildProfileFromReportRow_(reportRows[0])
    : null;

  const databaseProfile = databaseRows.length
    ? {
        phone: normalizePhone_(databaseRows[0][0]),
        parentName: String(databaseRows[0][1] || '').trim(),
        childName: String(databaseRows[0][2] || '').trim(),
        family: String(databaseRows[0][3] || '').trim()
      }
    : null;

  return {
    ok: true,
    reportsPresent: reportRows.length > 0,
    databasePresent: databaseRows.length > 0,
    reportProfile: reportProfile,
    databaseProfile: databaseProfile
  };
}

/** ========= НОРМАЛИЗАЦИИ ========= **/


function last10_(p) {
  const d = String(p || '').replace(/\D+/g, '');
  return d.slice(-10);
}

/** ========= Обработчик onEdit ========= **/
function onEdit(e) {
  try {
    if (!e) return;

    const sh = e.range.getSheet();
    const name = sh.getName();
    const row = e.range.getRow();
    const col = e.range.getColumn();

    // Report-source edits are handled by the installable onReportsD1Edit
    // trigger, which can call Cloudflare and must not be duplicated here.
    if (name === SHEET_MORNING || name === SHEET_EVENING || name === SHEET_PSYCHOLOGY) return;

    if (name === DATA_SHEET_NAME && row >= 2 && col === 1 && e.value) {
      const vals = sh.getRange(row, 1, 1, 4).getValues()[0];
      const phoneRaw = vals[0];
      const parentRaw = vals[1];
      const childRaw = vals[2];
      const famRaw = vals[3];

      const phone = normalizePhone_(phoneRaw);
      const parent = String(parentRaw || '').trim();
      const childC = String(childRaw || '').trim();
      const famD = String(famRaw || '').trim();

      if (!phone || phone.length < 10 || !parent || !childC) return;

      const childBase = stripInitialFromName_(childC) || childC;
      appendToDatabase_(phone, parent, childBase, famD);
      return;
    }

  } catch (err) {
    Logger.log('Ошибка в onEdit: ' + err);
  }
}

function stripLeadingNameHeader_(s) {
  if (!s) return s;

  return String(s)
    .replace(
      /^\s*[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z.\- ]{0,40}(?:\s+[А-ЯЁ])?\s*[:\-–—]\s*/u,
      ''
    )
    .trim();
}

function buildParentReportSnapshot_(phoneRaw, kindRaw, includeMissingRaw, rowsOverride) {
  const phone = onlyDigits_(phoneRaw);
  const kind = String(kindRaw || '').toLowerCase();
  if (!phone || !['morning', 'evening'].includes(kind)) {
    return { ok: false, hasReport: false, text: '' };
  }
  const rows = Array.isArray(rowsOverride) ? rowsOverride : getReportRowsByPhone_(phone);
  if (!rows.length) return { ok: false, hasReport: false, text: '' };
  const reports = [];
  let hasReport = false;
  rows.forEach(function(r) {
    const rawChild = String(r[2] || '');
    const reportText = kind === 'morning' ? r[4] : r[5];
    if (!isActualReportText_(reportText) || !rawReportRowOwnershipAllows_(kind, r)) {
      if (includeMissingRaw === true) reports.push('Отчёта пока нет. Пожалуйста, попробуйте позже 🙏');
      return;
    }
    hasReport = true;
    const displayName = baseNameTrimInitial_(rawChild);
    const body = stripLeadingNameHeader_(String(reportText));
    const safeBody = body.replace(
      new RegExp(`^\\s*${displayName}\\s+[А-ЯЁ]\\.?\\s*[:\\-–—]\\s*`, 'i'),
      ''
    );
    reports.push(`${displayName}: ${safeBody}`.trim());
  });
  return { ok: true, hasReport: hasReport, text: reports.join('\n\n') };
}

function getReportFor(phoneRaw, kindRaw, parentSessionRaw) {
  try {
    const phone = onlyDigits_(phoneRaw);
    const kind = String(kindRaw || '').toLowerCase();
    if (!phone || !['morning', 'evening'].includes(kind)) {
      return { ok: false, message: 'Некорректные данные запроса.' };
    }
    requireParentAccess_(phone, parentSessionRaw);

    const snapshot = buildParentReportSnapshot_(phone, kind, true);
    if (!snapshot.ok) {
      return { ok: false, message: 'Ваш номер не найден в системе. Пожалуйста, попробуйте позже.' };
    }
    return {
      ok: true,
      text: snapshot.text || 'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏',
      version: getReportVersion_(phone, kind),
      hasReport: snapshot.hasReport
    };

  } catch (err) {
    return { ok: false, message: 'Ошибка: ' + (err.message || err) };
  }
}

function getPsychologyReportFor(phoneRaw, parentSessionRaw) {
  try {
    const phone = onlyDigits_(phoneRaw);
    if (!phone) return { ok: false, message: 'Некорректные данные запроса.' };
    requireParentAccess_(phone, parentSessionRaw);

    const exists = checkPhoneExists(phone).ok;
    if (!exists) {
      return { ok: false, message: 'Ваш номер не найден в системе. Пожалуйста, попробуйте позже.' };
    }

    const sh = getSheet_(SHEET_PSYCHOLOGY);
    if (!sh) return { ok: false, message: 'Лист PSYCHOLOGY не найден.' };

    const text = String(sh.getRange(1, 1).getValue() || '').trim();
    if (!text) {
      return {
        ok: true,
        text: 'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏',
        version: getReportVersion_(phone, 'psychology'),
        hasReport: false
      };
    }

    return { ok: true, text, version: getReportVersion_(phone, 'psychology'), hasReport: true };

  } catch (err) {
    return { ok: false, message: 'Ошибка: ' + (err.message || err) };
  }
}

function cleanIncomingText_(raw) {
  let s = String(raw == null ? '' : raw);

  s = s.replace(/\r\n?/g, '\n');

  s = s
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\u00A0\u202F\u2000-\u200A]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s.normalize('NFC');
}

/** ========= appendReport ========= **/
function buildReportValidationChildren_() {
  const dataSheet = getDataSheet_();
  if (!dataSheet) return [];

  const lastRow = dataSheet.getLastRow();
  const count = Math.max(lastRow - 1, 0);
  if (count === 0) return [];

  const rawNames = dataSheet.getRange(2, 3, count, 1).getValues().flat();
  const families = dataSheet.getRange(2, 4, count, 1).getValues().flat();
  const normalizedNames = rawNames.map((name, index) => (
    normalizeReportChildName_(String(name || '').trim(), families[index])
      || String(name || '').trim()
  ));

  return attachPhonesToReportChildren_(
    buildReportChildren_(normalizedNames, families),
    dataSheet,
    count
  );
}

function childDisplayNameForReportError_(child, fallback) {
  return String(
    (child && (child.fullName || child.baseName))
      || fallback
      || ''
  ).trim();
}

function uniqueStrings_(items) {
  const seen = {};
  const out = [];
  (items || []).forEach(item => {
    const value = String(item || '').trim();
    if (!value || seen[value]) return;
    seen[value] = true;
    out.push(value);
  });
  return out;
}

function makeReportFormatError_(message, details) {
  return {
    ok: false,
    code: 'REPORT_FORMAT_ERROR',
    message,
    details: details || {}
  };
}

function getReportHeaderCandidatesForValidation_(text, knownBaseKeys, contextByBase) {
  const clean = cleanReportTextForParsing_(text);
  const candidates = [];
  if (!clean) return { clean, candidates };

  const headerRe = /(^|\n)\s*([^:\-–—\n]+?)\s*(?:\.?\s*([:\-–—]))\s*/g;
  let match;

  while ((match = headerRe.exec(clean)) !== null) {
    const header = getReportHeaderParts_(match[2].trim());
    const isKnownRegistered = !!(knownBaseKeys && knownBaseKeys[header.baseKey]);
    const isKnownName = isInNameBase(normalizeName_(header.baseRaw));
    const probableAliasChildren = (!isKnownRegistered && !isKnownName)
      ? findProbableReportAliasChildren_(header, contextByBase)
      : [];
    const isProbableAlias = probableAliasChildren.length > 0;
    const isUnassignedHeader = (!isKnownRegistered && !isKnownName && !isProbableAlias)
      ? isPotentialUnassignedReportHeader_(header)
      : false;

    if (!header.baseKey || (!isKnownRegistered && !isKnownName && !isProbableAlias && !isUnassignedHeader)) continue;

    const lineStart = match.index + (match[1] ? 1 : 0);
    const lineNumber = clean.slice(0, lineStart).split('\n').length;
    const separator = match[3] === ':' ? 'colon' : 'dash';
    const block = {
      rawName: header.raw,
      baseRaw: header.baseRaw,
      baseKey: header.baseKey,
      suffix: header.suffix,
      suffixKey: header.suffixKey,
      hasSuffix: header.hasSuffix,
      body: '',
      start: match.index,
      headerEnd: headerRe.lastIndex,
      prefix: match[1] || ''
    };
    const resolution = isProbableAlias
      ? makeUnknownReportAliasResolution_(probableAliasChildren)
      : (isUnassignedHeader ? makeUnassignedReportHeaderResolution_() : resolveReportBlock_(block, contextByBase));

    candidates.push({
      rawName: header.raw,
      baseKey: header.baseKey,
      hasSuffix: header.hasSuffix,
      suffix: header.suffix,
      suffixKey: header.suffixKey,
      separator,
      start: match.index,
      headerEnd: headerRe.lastIndex,
      lineNumber,
      directResolution: resolution,
      resolution
    });
  }

  const resolved = resolveReportBlocksByExclusion_(candidates.map(function(item) {
    return Object.assign({}, item, { forcedResolution:item.resolution });
  }), contextByBase);
  candidates.forEach(function(item, index) { item.resolution = resolved[index]; });
  return { clean, candidates };
}

function buildReportLineStartLabels_(children) {
  const labels = [];

  (children || []).forEach(child => {
    if (!child) return;

    const fullName = String(child.fullName || '').trim();
    const baseName = String(child.baseName || stripInitialFromName_(fullName) || '').trim();
    const suffix = String(child.suffix || '').trim();
    const variants = getAllNameVariantsForBase_(baseName || fullName);
    const values = [];

    if (fullName) values.push(fullName);
    if (baseName) values.push(baseName);
    variants.forEach(variant => {
      if (!variant) return;
      values.push(variant);
      if (suffix) values.push(`${variant} ${suffix}`);
    });

    uniqueStrings_(values)
      .sort((a, b) => b.length - a.length)
      .forEach(value => labels.push({
        label: value,
        display: childDisplayNameForReportError_(child, value),
        identityKey: reportChildIdentityKey_(child),
        baseKey: child.baseKey || getNameBaseKey_(baseName || value),
        // В тексте отчёта имя ребёнка нередко повторяется в начале нового
        // абзаца: «Маша рассказала…». Такой абзац не является заголовком
        // следующего блока, если для этой Маши уже найден корректный
        // заголовок выше.
        isBareBaseLabel: !getReportHeaderParts_(value).hasSuffix
      }));
  });

  return labels.sort((a, b) => b.label.length - a.label.length);
}

function hasReportHeaderSeparator_(line) {
  // Если после заголовка уже есть разрешённый разделитель, эта строка не
  // может одновременно считаться строкой «без : или -». Это защищает от
  // ложной ошибки при совпадающих именах и вариантах имён.
  return /^[^:\-–—\n]+?\s*\.?\s*[:\-–—]/.test(String(line || ''));
}

function findMissingReportDelimiters_(cleanText, children, startLineNumber, confirmedHeaderLines) {
  const labels = buildReportLineStartLabels_(children);
  const found = [];
  const seen = {};
  const confirmed = confirmedHeaderLines || {};
  const lines = String(cleanText || '').split('\n');

  for (let i = Math.max(0, (startLineNumber || 1) - 1); i < lines.length; i += 1) {
    const line = String(lines[i] || '').trim();
    if (!line) continue;
    if (!/^[А-ЯЁA-Z]/.test(line)) continue;
    if (hasReportHeaderSeparator_(line)) continue;

    for (const item of labels) {
      const label = escapeRegExp_(item.label).replace(/\s+/g, '\\s+');
      const validHeaderForThisNameRe = new RegExp('^' + label + '\\.?\\s*[:\\-–—]', 'i');
      const missingDelimiterRe = new RegExp('^(' + label + ')\\.?(?=$|[\\s,])', 'i');

      if (validHeaderForThisNameRe.test(line)) break;
      const missingMatch = line.match(missingDelimiterRe);
      if (!missingMatch) continue;

      // Имя может встретиться внутри уже корректно найденного блока:
      // «Полина: ...\nПолина переживает...». Это продолжение текста, а не
      // новый отчёт. Пропущенный заголовок другого ребёнка по-прежнему
      // остаётся критической ошибкой.
      const confirmedLine = Number(confirmed[item.identityKey] || 0);
      if (confirmedLine && confirmedLine < i + 1) break;

      // У двух детей может быть одно и то же имя. Например, после блока
      // «Маша У.: …» воспитатель естественно пишет отдельным абзацем
      // «Маша рассказала…». Метка «Маша» принадлежит также второй Маше,
      // поэтому одной проверки по identityKey недостаточно. Если любой
      // ребёнок с тем же базовым именем уже имеет заголовок выше, это
      // продолжение его текста, а не пропущенный разделитель.
      const hasConfirmedBaseAbove = item.isBareBaseLabel && (children || []).some(child => {
        if (!child || child.baseKey !== item.baseKey) return false;
        const childLine = Number(confirmed[reportChildIdentityKey_(child)] || 0);
        return childLine && childLine < i + 1;
      });
      if (hasConfirmedBaseAbove) break;

      // Для подсказки показываем ровно то имя, которое написал воспитатель,
      // а не расширенное имя из таблицы («Полина», а не «Полина Р.»).
      const rawName = String(missingMatch[1] || item.label || '')
        .replace(/\.$/, '')
        .trim();
      if (!seen[rawName]) {
        seen[rawName] = true;
        found.push({ name: rawName, lineNumber: i + 1 });
      }
      break;
    }
  }

  return found;
}

function buildConfirmedReportHeaderLines_(candidates) {
  const lines = {};

  (candidates || []).forEach(item => {
    if (!item || !item.resolution || item.resolution.status !== 'ok') return;
    const targets = (item.resolution.children && item.resolution.children.length)
      ? item.resolution.children
      : (item.resolution.child ? [item.resolution.child] : []);
    const line = Number(item.lineNumber || 0);

    targets.forEach(child => {
      const key = reportChildIdentityKey_(child);
      if (!key || !line) return;
      if (!lines[key] || line < lines[key]) lines[key] = line;
    });
  });

  return lines;
}

function reportAmbiguousNameMessage_(names) {
  return 'Ошибка отправки отчёта. Не получается определить ребёнка: «' +
    names.join('», «') +
    '». В таблице есть несколько подходящих детей. Добавьте инициал или уточните фамилию.';
}

function reportDuplicateBlockMessage_(names) {
  return 'Ошибка отправки отчёта. Для ребёнка «' +
    names.join('», «') +
    '» найдено два блока с разделителем. Проверьте, не попал ли сюда блок для врачей.';
}

function reportMissingDelimiterMessage_(names) {
  if (names.length === 1) {
    return 'Ошибка отправки отчёта. После имени «' + names[0] +
      '» не вижу «:» или тире. Поставьте разделитель, иначе текст может попасть в отчёт предыдущего ребёнка.';
  }

  return 'Ошибка отправки отчёта. После имён «' + names.join('», «') +
    '» не вижу «:» или тире. Поставьте разделители, иначе текст может попасть в отчёт предыдущего ребёнка.';
}

function validateChildReportFormat_(reportType, text) {
  const children = buildReportValidationChildren_();
  const knownBaseKeys = buildKnownBaseKeys_(children);
  const contextByBase = buildDistributionContext_(children, []);
  const parsed = getReportHeaderCandidatesForValidation_(text, knownBaseKeys, contextByBase);
  const candidates = parsed.candidates || [];
  const okCandidates = candidates.filter(item => item.resolution && item.resolution.status === 'ok');

  // Count directly resolved headers before exclusion-based name inference:
  // that inference can mark two identical bare names ambiguous and hide a
  // real duplicate from the sender.
  const duplicateByIdentity = {};
  const duplicateNames = [];
  candidates.forEach(item => {
    const resolution = item.directResolution && item.directResolution.status === 'ok'
      ? item.directResolution : item.resolution;
    if (!resolution || resolution.status !== 'ok') return;
    const targets = reportResolutionTargets_(resolution);
    const identitiesInBlock = {};
    targets.forEach(child => {
      const identity = reportChildIdentityKey_(child);
      if (!identity || identitiesInBlock[identity]) return;
      identitiesInBlock[identity] = true;
      if (!duplicateByIdentity[identity]) {
        duplicateByIdentity[identity] = { count:0, name:childDisplayNameForReportError_(child, item.rawName) };
      }
      duplicateByIdentity[identity].count += 1;
    });
  });
  Object.keys(duplicateByIdentity).forEach(identity => {
    const item = duplicateByIdentity[identity];
    if (item.count > 1) duplicateNames.push(item.name);
  });
  if (duplicateNames.length) {
    const names = uniqueStrings_(duplicateNames).slice(0, 8);
    return makeReportFormatError_(reportDuplicateBlockMessage_(names), { duplicateNames:names });
  }

  if (okCandidates.length === 0) {
    const ambiguous = candidates.filter(item => item.resolution && item.resolution.status === 'ambiguous');
    if (ambiguous.length) {
      const names = uniqueStrings_(ambiguous.map(item => item.rawName)).slice(0, 8);
      return { ok:true, reportType:reportType, checkedBlocks:0, skippedBlocks:candidates.length, ambiguousNames:names };
    }

    if (candidates.length > 0) {
      return {
        ok: true,
        reportType,
        checkedBlocks: 0,
        skippedBlocks: candidates.length
      };
    }

    return makeReportFormatError_(
      'Ошибка отправки отчёта. Не найдено ни одного блока в формате “Имя: текст” или “Имя - текст”.',
      { reason: 'no_child_headers' }
    );
  }

  const mainStart = okCandidates[0].start;
  const mainStartLine = okCandidates[0].lineNumber || 1;
  const mainCandidates = candidates.filter(item => item.start >= mainStart);
  const preMainAmbiguous = candidates.filter(item => (
    item.start < mainStart &&
    item.resolution &&
    item.resolution.status === 'ambiguous'
  ));

  const ambiguous = preMainAmbiguous.concat(
    mainCandidates.filter(item => item.resolution && item.resolution.status === 'ambiguous')
  );
  const ambiguousNames = uniqueStrings_(ambiguous.map(item => item.rawName));

  // Only an explicit ":" or dash makes a child-name line a report header.
  // A bare "Лиза Ф" can be an ordinary mention inside another child's block
  // and must never become a validation error or a candidate header by itself.

  return {
    ok: true,
    reportType,
    checkedBlocks: okCandidates.length,
    skippedBlocks: ambiguous.length,
    ambiguousNames: ambiguousNames
  };
}

const REPORT_SUBMISSION_PROPERTY_PREFIX_ = 'REPORT_SUBMISSION_V1_';
const REPORT_SUBMISSION_TTL_MS_ = 2 * 24 * 60 * 60 * 1000;

function normalizeReportSubmissionId_(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(id) ? id : '';
}

function reportSubmissionPropertyKey_(id) {
  return REPORT_SUBMISSION_PROPERTY_PREFIX_ + id;
}

function readReportSubmission_(id) {
  if (!id) return null;
  const raw = PropertiesService.getScriptProperties().getProperty(reportSubmissionPropertyKey_(id));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    return null;
  }
}

function writeReportSubmission_(id, value) {
  if (!id) return;
  PropertiesService.getScriptProperties().setProperty(
    reportSubmissionPropertyKey_(id),
    JSON.stringify(value || {})
  );
}

function cleanupReportSubmissions_() {
  const props = PropertiesService.getScriptProperties();
  const markerKey = 'REPORT_SUBMISSION_LAST_CLEANUP';
  const now = Date.now();
  const lastCleanup = Number(props.getProperty(markerKey) || 0);
  if (lastCleanup && now - lastCleanup < 6 * 60 * 60 * 1000) return;
  const all = props.getProperties();
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(REPORT_SUBMISSION_PROPERTY_PREFIX_) !== 0) return;
    try {
      const item = JSON.parse(all[key] || '{}');
      if (!Number(item.updatedAt) || now - Number(item.updatedAt) > REPORT_SUBMISSION_TTL_MS_) {
        props.deleteProperty(key);
      }
    } catch (_) {
      props.deleteProperty(key);
    }
  });
  props.setProperty(markerKey, String(now));
}

function claimReportSubmission_(id, typeRaw, fingerprint, legacyFingerprint) {
  if (!id) return { claimed:true, state:null };
  const lock = LockService.getScriptLock();
  // The Worker owns a durable retry queue. If another Apps Script task holds
  // the shared lock, return quickly and let that queue retry instead of making
  // a report request wait up to ten seconds.
  if (!lock.tryLock(500)) {
    return { claimed:false, state:{ status:'processing', type:typeRaw, fingerprint:fingerprint, updatedAt:Date.now() }, deferred:true };
  }
  try {
    const existing = readReportSubmission_(id);
    if (existing) {
      if (existing.type !== typeRaw || (existing.fingerprint !== fingerprint && existing.fingerprint !== legacyFingerprint)) {
        return { claimed:false, mismatch:true, state:existing };
      }
      // The Worker retries transient Apps Script errors. A failed claim must
      // be reclaimable, otherwise every retry returns the same cached error.
      // An abandoned processing/saved claim is reclaimed only after the
      // maximum Apps Script execution window has passed.
      const stale = ['processing', 'saved'].indexOf(existing.status) >= 0 &&
        Date.now() - Number(existing.updatedAt || existing.startedAt || 0) > 10 * 60 * 1000;
      if (existing.status === 'failed' || stale) {
        const state = {
          status:'processing', type:typeRaw, fingerprint:fingerprint,
          startedAt:Number(existing.startedAt) || Date.now(), updatedAt:Date.now()
        };
        writeReportSubmission_(id, state);
        return { claimed:true, state:state };
      }
      return { claimed:false, state:existing };
    }
    const state = {
      status:'processing',
      type:typeRaw,
      fingerprint:fingerprint,
      startedAt:Date.now(),
      updatedAt:Date.now()
    };
    writeReportSubmission_(id, state);
    return { claimed:true, state:state };
  } finally {
    lock.releaseLock();
  }
}

function getReportSubmissionStatus(submissionIdRaw, tutorTokenRaw) {
  requireTutorSession_(tutorTokenRaw);
  const submissionId = normalizeReportSubmissionId_(submissionIdRaw);
  if (!submissionId) return { ok:false, message:'Некорректный идентификатор отправки.' };
  const state = readReportSubmission_(submissionId);
  if (!state) return { ok:true, status:'not_found', submissionId:submissionId };
  return {
    ok:true,
    status:String(state.status || 'processing'),
    submissionId:submissionId,
    result:state.result || null,
    message:String(state.message || '')
  };
}

// Report retries carry the original submission time. A retry of an old
// queued request must not overwrite a newer website or manual publication.
function saveRawReportPublication_(kind, cell, text, publicationAt, expectedRaw, authoredRaw) {
  // Report publication/distribution has its own lock so long profile syncs
  // cannot prevent a report from being saved or canonicalized.
  const lock = LockService.getUserLock();
  lock.waitLock(5000);
  try {
    if (expectedRaw !== undefined && String(cell.getValue() || '') !== expectedRaw) return false;
    const properties = PropertiesService.getScriptProperties();
    const key = 'RAW_REPORT_PUBLICATION_AT_' + kind;
    const previousAt = Number(properties.getProperty(key) || 0);
    if (Number(publicationAt) < previousAt) return false;
    rememberRawReportPublicationOwnership_(kind, text, authoredRaw === undefined ? expectedRaw : authoredRaw);
    cell.setValue(text);
    properties.setProperty(key, String(publicationAt));
    return true;
  } finally { lock.releaseLock(); }
}

function appendReport(param, tutorTokenRaw) {
  let submissionId = '';
  try {
    if (String(tutorTokenRaw || '') !== String(getWorkerSharedSecret_() || '')) requireTutorSession_(tutorTokenRaw);
    cleanupReportSubmissions_();
    const typeRaw = String(param?.reportType || '').trim().toLowerCase();
    if (!typeRaw) return { ok: false, message: 'Тип отчёта не указан.' };

    let targetSheetName = '';
    if (typeRaw === 'morning') targetSheetName = SHEET_MORNING;
    else if (typeRaw === 'evening') targetSheetName = SHEET_EVENING;
    else if (typeRaw === 'psychology') targetSheetName = SHEET_PSYCHOLOGY;
    else return { ok: false, message: 'Неизвестный тип отчёта.' };

    const sheet = getSheet_(targetSheetName);
    if (!sheet) return { ok: false, message: `Лист "${targetSheetName}" не найден.` };

    const raw = (param && param.text) || '';
    let text = cleanIncomingText_(raw);

    if (!text) return { ok: false, message: 'Пустой текст отчёта.' };

    let reportValidation = null;
    if (targetSheetName !== SHEET_PSYCHOLOGY) {
      const prepared = prepareRawReportSourceText_(typeRaw, text);
      if (!prepared.ok) return prepared.validation;
      text = prepared.text;
      reportValidation = prepared.validation;
    } else {
      text = normalizeReportSourcePunctuation_(text);
    }

    submissionId = normalizeReportSubmissionId_(param && param.submissionId);
    if (param && param.submissionId && !submissionId) {
      return { ok:false, message:'Некорректный идентификатор отправки.' };
    }
    // Identity/header canonicalization may change between retry attempts.
    // The submission identity belongs to the submitted text, not table names.
    const fingerprint = reportFingerprint_(typeRaw + '\n' + cleanIncomingText_(raw));
    const legacyFingerprint = reportFingerprint_(typeRaw + '\n' + text);
    const claim = claimReportSubmission_(submissionId, typeRaw, fingerprint, legacyFingerprint);
    if (claim.mismatch) {
      return { ok:false, message:'Эта попытка отправки уже относится к другому отчёту.' };
    }
    if (!claim.claimed) {
      if (claim.state.status === 'completed') return claim.state.result;
      if (claim.state.status === 'failed') {
        return { ok:false, message:String(claim.state.message || 'Не удалось отправить отчёт.'), submissionId:submissionId };
      }
      return { ok:true, processing:true, submissionId:submissionId };
    }

    const submittedAt = Number(param && param.submittedAt);
    const publicationAt = Number.isFinite(submittedAt) && submittedAt > 0 && submittedAt <= Date.now() + 60000
      ? submittedAt : (Number(claim.state && claim.state.startedAt) || Date.now());
    if (!saveRawReportPublication_(typeRaw, sheet.getRange(1, 1), text, publicationAt, undefined, raw)) {
      const superseded = {ok:true, superseded:true, submissionId:submissionId, message:'Уже сохранён более свежий отчёт.'};
      if (submissionId) writeReportSubmission_(submissionId, {status:'completed',type:typeRaw,fingerprint:fingerprint,result:superseded,updatedAt:Date.now()});
      return superseded;
    }
    if (submissionId) {
      writeReportSubmission_(submissionId, {
        status:'saved',
        startedAt:publicationAt,
        type:typeRaw,
        fingerprint:fingerprint,
        updatedAt:Date.now()
      });
    }

    if (targetSheetName === SHEET_PSYCHOLOGY) {
      recordReportHistoryPublication_('psychology', text);
      if (typeof queueReportPostCommitSync_ === 'function') queueReportPostCommitSync_([], [], ['psychology']);
      try {
        if (typeof flushPendingReportPostCommitSync_ === 'function') flushPendingReportPostCommitSync_();
        else syncD1CurrentReportsToWorker_('psychology');
      } catch (error) {
        Logger.log('REPORT_CURRENT_SYNC_AFTER_PSYCHOLOGY_FAILED ' + (error && error.message || error));
      }
    } else {
      distributeChildReports(typeRaw);
    }
    setRawReportSourceNote_(sheet.getRange(1, 1), rawReportValidationNote_(reportValidation));

    const result = {
      ok: true,
      sheet: targetSheetName,
      submissionId: submissionId,
      message: targetSheetName === SHEET_PSYCHOLOGY
        ? 'Отчёт успешно отправлен.'
        : 'Отчёт успешно отправлен.'
    };
    if (submissionId) {
      writeReportSubmission_(submissionId, {
        status:'completed',
        type:typeRaw,
        fingerprint:fingerprint,
        result:result,
        updatedAt:Date.now()
      });
    }
    return result;
  } catch (e) {
    if (submissionId) {
      const previous = readReportSubmission_(submissionId) || {};
      writeReportSubmission_(submissionId, {
        status:'failed',
        startedAt:Number(previous.startedAt) || Date.now(),
        type:String(previous.type || ''),
        fingerprint:String(previous.fingerprint || ''),
        message:'Ошибка: ' + (e.message || e),
        updatedAt:Date.now()
      });
    }
    return { ok: false, message: 'Ошибка: ' + (e.message || e) };
  }
}

// Server-to-server queue boundary. The caller is authenticated in doPost by
// the private worker secret; keeping this wrapper separate prevents the
// browser API from gaining an unauthenticated report path.
function appendReportFromWorker_(param) {
  return appendReport(param, getWorkerSharedSecret_());
}


function testAppendReportToTestSheet(param, tutorTokenRaw) {
  const TEST_SHEET_NAME = 'TEST_REPORTS_API';

  try {
    try {
      requireTutorSession_(tutorTokenRaw);
    } catch (e) {
      return {
        ok: false,
        code: 'AS-W10 AUTH',
        message: 'Сессия воспитателя отклонена: ' + (e.message || e)
      };
    }

    const typeRaw = String(param && param.reportType || '').trim().toLowerCase();
    if (!['morning', 'evening', 'psychology'].includes(typeRaw)) {
      return {
        ok: false,
        code: 'AS-W11 BAD_TYPE',
        message: 'Неизвестный тип тестового отчёта.'
      };
    }

    const text = cleanIncomingText_(String(param && param.text || ''));
    if (!text) {
      return {
        ok: false,
        code: 'AS-W12 EMPTY',
        message: 'После очистки текст отчёта пуст.'
      };
    }

    let sh;
    try {
      const ss = getSpreadsheet_();
      if (!ss) throw new Error('getSpreadsheet_() вернул пустое значение.');

      sh = ss.getSheetByName(TEST_SHEET_NAME);

      if (!sh) {
        sh = ss.insertSheet(TEST_SHEET_NAME);
        sh.getRange(1, 1, 1, 4).setValues([[
          'TIMESTAMP',
          'WRITE_ID',
          'REPORT_TYPE',
          'TEXT'
        ]]);
      }
    } catch (e) {
      return {
        ok: false,
        code: 'AS-W13 SHEET',
        message: 'Не удалось открыть или создать тестовый лист: ' + (e.message || e)
      };
    }

    const writeId = Utilities.getUuid();
    let row;

    try {
      sh.appendRow([
        new Date(),
        writeId,
        typeRaw,
        text
      ]);

      row = sh.getLastRow();
    } catch (e) {
      return {
        ok: false,
        code: 'AS-W14 WRITE',
        message: 'Ошибка записи строки: ' + (e.message || e)
      };
    }

    try {
      const saved = sh.getRange(row, 1, 1, 4).getValues()[0];

      const savedId = String(saved[1] || '');
      const savedType = String(saved[2] || '');
      const savedText = String(saved[3] || '');

      if (
        savedId !== writeId ||
        savedType !== typeRaw ||
        savedText !== text
      ) {
        return {
          ok: false,
          code: 'AS-W15 VERIFY',
          message: 'Контрольное чтение не совпало с отправленными данными.',
          expected: {
            writeId: writeId,
            reportType: typeRaw,
            text: text
          },
          actual: {
            writeId: savedId,
            reportType: savedType,
            text: savedText
          }
        };
      }

      return {
        ok: true,
        sheet: TEST_SHEET_NAME,
        row: row,
        writeId: writeId,
        reportType: savedType,
        text: savedText
      };

    } catch (e) {
      return {
        ok: false,
        code: 'AS-W15 VERIFY',
        message: 'Не удалось выполнить контрольное чтение: ' + (e.message || e)
      };
    }

  } catch (e) {
    return {
      ok: false,
      code: 'AS-W16 INTERNAL',
      message: 'Непредвиденная ошибка тестового метода: ' + (e.message || e)
    };
  }
}


function testValidateAndWriteReport(param, tutorTokenRaw) {
  const TEST_SHEET_NAME = 'TEST_REPORTS_VALIDATED';

  try {
    // Test bench deliberately requires an educator session for all three types.
    // Production report sheets are not touched.
    try {
      requireTutorSession_(tutorTokenRaw);
    } catch (e) {
      return {
        ok: false,
        code: 'AS-V10 AUTH',
        message: 'Сессия воспитателя отклонена: ' + (e.message || e)
      };
    }

    const typeRaw = String(param && param.reportType || '').trim().toLowerCase();

    if (!['morning', 'evening', 'psychology'].includes(typeRaw)) {
      return {
        ok: false,
        code: 'AS-V11 BAD_TYPE',
        message: 'Неизвестный тип отчёта.'
      };
    }

    const text = cleanIncomingText_(String(param && param.text || ''));

    if (!text) {
      return {
        ok: false,
        code: 'AS-V12 EMPTY',
        message: 'Пустой текст отчёта после cleanIncomingText_.'
      };
    }

    let validation = {
      ok: true,
      reportType: typeRaw,
      skipped: typeRaw === 'psychology'
    };

    // Это ровно тот же validator, который использует production appendReport.
    if (typeRaw !== 'psychology') {
      validation = validateChildReportFormat_(typeRaw, text);

      if (!validation || !validation.ok) {
        return {
          ok: false,
          code: 'AS-V13 VALIDATION',
          message:
            (validation && validation.message) ||
            'validateChildReportFormat_ отклонила отчёт.',
          validation: validation || null
        };
      }
    }

    let sh;

    try {
      const ss = getSpreadsheet_();
      if (!ss) throw new Error('getSpreadsheet_() вернул пустое значение.');

      sh = ss.getSheetByName(TEST_SHEET_NAME);

      if (!sh) {
        sh = ss.insertSheet(TEST_SHEET_NAME);
        sh.getRange(1, 1, 1, 6).setValues([[
          'TIMESTAMP',
          'WRITE_ID',
          'REPORT_TYPE',
          'VALIDATION',
          'TEXT',
          'CHECKED_BLOCKS'
        ]]);
      }
    } catch (e) {
      return {
        ok: false,
        code: 'AS-V14 SHEET',
        message: 'Не удалось открыть или создать тестовый лист: ' + (e.message || e)
      };
    }

    const writeId = Utilities.getUuid();
    let row;

    try {
      sh.appendRow([
        new Date(),
        writeId,
        typeRaw,
        JSON.stringify(validation),
        text,
        Number(validation.checkedBlocks || 0)
      ]);

      row = sh.getLastRow();
    } catch (e) {
      return {
        ok: false,
        code: 'AS-V15 WRITE',
        message: 'Валидация прошла, но тестовая запись упала: ' + (e.message || e)
      };
    }

    try {
      const saved = sh.getRange(row, 1, 1, 6).getValues()[0];

      if (
        String(saved[1] || '') !== writeId ||
        String(saved[2] || '') !== typeRaw ||
        String(saved[4] || '') !== text
      ) {
        return {
          ok: false,
          code: 'AS-V16 VERIFY',
          message: 'Контрольное чтение не совпало с отправленными данными.',
          expected: {
            writeId: writeId,
            reportType: typeRaw,
            text: text
          },
          actual: {
            writeId: String(saved[1] || ''),
            reportType: String(saved[2] || ''),
            text: String(saved[4] || '')
          }
        };
      }

      return {
        ok: true,
        sheet: TEST_SHEET_NAME,
        row: row,
        writeId: writeId,
        reportType: typeRaw,
        checkedBlocks: Number(validation.checkedBlocks || 0),
        validation: validation
      };

    } catch (e) {
      return {
        ok: false,
        code: 'AS-V16 VERIFY',
        message: 'Не удалось выполнить контрольное чтение: ' + (e.message || e)
      };
    }

  } catch (e) {
    return {
      ok: false,
      code: 'AS-V17 INTERNAL',
      message: 'Непредвиденная ошибка: ' + (e.message || e)
    };
  }
}


/** ========= ЧАТ РОДИТЕЛЕЙ И ВОСПИТАТЕЛЕЙ ========= **/


/** ========= СОСТОЯНИЕ НЕПРОЧИТАННЫХ ОТЧЁТОВ ========= **/

function isActualReportText_(raw) {
  const text = cleanIncomingText_(raw);
  return !!text &&
    text !== 'Пока ещё нет отчёта 🙏' &&
    text !== 'Пока нет отчёта. Пожалуйста, попробуйте позже 🙏' &&
    text !== 'Отчёта пока нет. Пожалуйста, попробуйте позже 🙏';
}

function reportFingerprint_(raw) {
  const text = cleanIncomingText_(raw);
  if (!isActualReportText_(text)) return '';
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, '');
}

function getReportUnreadStatus_(phoneRaw) {
  const empty={morning:false,evening:false,psychology:false};
  try{const state=getD1ParentReportUnread_(phoneRaw);return state&&state.reportUnread||empty;}
  catch(error){Logger.log('REPORT_READ_STATE_D1_READ_FAILED '+String(error&&error.message||error));return empty;}
}

function getReportVersion_(phoneRaw, kindRaw) {
  const phone10 = last10_(phoneRaw);
  const kind = String(kindRaw || '').toLowerCase();
  const offsets = { morning: 1, evening: 3, psychology: 5 };
  if (!phone10 || offsets[kind] === undefined) return '';
  // Compute the same canonical version D1 stores, without adding a network
  // round trip every time a parent opens a report.
  if (kind === 'psychology') {
    const sheet = getSheet_(SHEET_PSYCHOLOGY);
    return sheet ? reportFingerprint_(String(sheet.getRange(1, 1).getValue() || '')) : '';
  }
  const data = getDataSheet_(), count = data ? Math.max(data.getLastRow() - 1, 0) : 0;
  if (count) {
    const sourceRows = data.getRange(2, 1, count, 6).getValues().filter(function(row) { return last10_(row[0]) === phone10; });
    return reportContentVersionForD1_(sourceRows, kind);
  }
  return '';
}


function getParentUnreadState(phoneRaw, parentSessionRaw) {
  try {
    requireParentAccess_(phoneRaw, parentSessionRaw);
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) };
  }
  const worker=getD1ParentUnreadState_(phoneRaw);
  return {ok:true,hasUnread:!!(worker&&worker.hasUnread),reportUnread:worker&&worker.reportUnread||{morning:false,evening:false,psychology:false}};
}

function markReportAsRead(phoneRaw, kindRaw, expectedVersionRaw, parentSessionRaw) {
  const phone10 = last10_(phoneRaw);
  const kind = String(kindRaw || '').toLowerCase();
  if (!phone10 || !['morning','evening','psychology'].includes(kind)) return { ok: false, message: 'Некорректный отчёт.' };
  requireParentAccess_(phone10, parentSessionRaw);
  try { return markD1ParentReportRead_(phone10,kind,String(expectedVersionRaw||'')); }
  catch(e) { return {ok:false,message:String(e&&e.message||e)}; }
}


function getPushWorkerConfig_() {
  const props = PropertiesService.getScriptProperties();
  const propUrl = String(props.getProperty('MEDSI_PUSH_WORKER_URL') || '').trim();
  const propSecret = String(props.getProperty('MEDSI_PUSH_WORKER_SECRET') || '').trim();
  const isExpectedWorkerUrl = /^https:\/\/medsi-push-worker\.medsi-children\.workers\.dev\/notify$/i.test(propUrl);

  return {
    url: isExpectedWorkerUrl ? propUrl : PUSH_WORKER_URL_FALLBACK,
    secret: getWorkerSharedSecret_() || propSecret
  };
}

function sendPushViaWorker_(role, phone, notification) {
  const cfg = getPushWorkerConfig_();
  if (!cfg.url || !cfg.secret) {
    return { ok: false, skipped: true };
  }

  const response = UrlFetchApp.fetch(cfg.url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + cfg.secret
    },
    payload: JSON.stringify({
      role,
      phone,
      notification
    })
  });

  const code = response.getResponseCode();
  const text = response.getContentText() || '';
  let parsed = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (e) {
    parsed = null;
  }

  if (code >= 200 && code < 300) {
    return {
      ok: !!(parsed && parsed.ok),
      code,
      sent: parsed && typeof parsed.sent !== 'undefined' ? parsed.sent : '',
      failed: parsed && typeof parsed.failed !== 'undefined' ? parsed.failed : '',
      total: parsed && typeof parsed.total !== 'undefined' ? parsed.total : '',
      message: text
    };
  }

  return {
    ok: false,
    code,
    disabled: code === 404 || code === 410,
    message: text
  };
}

function sendPushDebugEvent_(payload) {
  try {
    const response = UrlFetchApp.fetch('https://medsi-push-worker.medsi-children.workers.dev/debug/client', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(payload || {})
    });
    return {
      ok: true,
      code: response.getResponseCode(),
      text: String(response.getContentText() || '').slice(0, 500)
    };
  } catch (e) {
    return { ok: false, message: String(e && e.message || e) };
  }
}


function sendPushNotification_(role, phone, notification) {
  const res = sendPushViaWorker_(role, phone, notification);

  if (res && res.skipped) {
    Logger.log('Push skipped: worker is not configured');
    return res;
  }

  Logger.log(
    'Push notify result: role=' + role +
    ', ok=' + !!(res && res.ok) +
    ', sent=' + String((res && res.sent) || '') +
    ', total=' + String((res && res.total) || '') +
    ', failed=' + String((res && res.failed) || '') +
    ', message=' + String((res && (res.message || res.code)) || '')
  );

  return res;
}


function getActiveReportPhonesSet_() {
  const sh = getDataSheet_();
  const set = new Set();

  if (!sh) return set;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return set;

  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues().flat();

  values.forEach(v => {
    const p10 = last10_(v);
    if (p10) set.add(p10);
  });

  return set;
}

function isPhoneActiveInReports_(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return false;

  const activePhones = getActiveReportPhonesSet_();
  if (activePhones.has(phone10)) return true;
  // Newly registered accounts are committed in D1 first and materialized to
  // REPORTS asynchronously. During that short sync window, D1 is authoritative.
  try {
    const value = d1AdminRequest_('/admin/profile/' + encodeURIComponent(phone10), 'get');
    return !!(value && value.profile && last10_(value.profile.phone) === phone10);
  } catch (_) {
    return false;
  }
}

function getReportChildDeletionPreview(phoneRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok: false, message: 'Не удалось определить номер родителя.' };

    const sh = getDataSheet_();
    const lastRow = sh ? sh.getLastRow() : 0;
    if (lastRow < 2) return { ok: false, message: 'Строка ребёнка уже удалена.' };

    const values = sh.getRange(2, 1, lastRow - 1, 4).getValues();
    const names = normalizeReportChildNames_(
      sh,
      values.map(row => String(row[2] || '').trim()),
      values.map(row => String(row[3] || '').trim())
    );
    const index = values.findIndex(row => last10_(row[0]) === phone10);
    if (index < 0) return { ok: false, message: 'Строка ребёнка уже удалена.' };

    return { ok: true, phone: normalizePhone_(values[index][0]), childName: names[index] || 'Без имени ребёнка' };
  } catch (e) {
    return { ok: false, message: 'Не удалось подготовить удаление: ' + (e.message || e) };
  }
}

function syncReportInactivityState_(updates) {
  const list=(updates||[]).map((item,index)=>{const phone=last10_(item&&item.phone);return phone&&item.hasNewReport===true?{phone,hasNewReport:true,rosterOrder:index}:null;}).filter(Boolean);
  if(!list.length)return {ok:true,skipped:true};
  return d1AdminRequest_('/admin/report-inactivity/sync','post',{items:list});
}

function removeReportInactivityState_(phoneRaw) {
  const phone = last10_(phoneRaw);
  if (!phone) return { ok:true, deleted:false };
  return d1AdminRequest_('/admin/report-inactivity/remove','post',{ phone:phone });
}

function getReportInactivityReminder(tutorTokenRaw) {
  try{requireTutorSession_(tutorTokenRaw);return d1EducatorWorkerRequest_('/lab/report-inactivity','get');}
  catch(e){return {ok:false,message:'Не удалось проверить напоминания: '+String(e&&e.message||e)};}
}

function acknowledgeReportInactivityReminder(phoneRaw,tierRaw,expectedLastReportAtRaw,expectedFirstSeenAtRaw,tutorTokenRaw) {
  try{
    if(tutorTokenRaw===undefined&&expectedFirstSeenAtRaw===undefined&&typeof expectedLastReportAtRaw==='string'){tutorTokenRaw=expectedLastReportAtRaw;expectedLastReportAtRaw=undefined;}
    requireTutorSession_(tutorTokenRaw);
    if(expectedLastReportAtRaw===undefined){const current=d1EducatorWorkerRequest_('/lab/report-inactivity','get').reminder;if(!current||last10_(current.phone)!==last10_(phoneRaw)||Number(current.tier)!==Number(tierRaw))return {ok:false,message:'Напоминание уже изменилось.'};expectedLastReportAtRaw=current.lastNewReportAt;expectedFirstSeenAtRaw=current.firstSeenAt;}
    return d1EducatorWorkerRequest_('/lab/report-inactivity/ack','post',{phone:last10_(phoneRaw),tier:Number(tierRaw),expectedLastNewReportAt:Number(expectedLastReportAtRaw||0),expectedFirstSeenAt:Number(expectedFirstSeenAtRaw||0)});
  }catch(e){return {ok:false,message:'Не удалось отметить напоминание: '+String(e&&e.message||e)};}
}

function deletionProfileMatchesExpected_(row, expectedRaw) {
  const expected = expectedRaw || {};
  const expectedParent = String(expected.parentName || '').trim().toLocaleLowerCase('ru');
  const expectedChild = String(expected.childName || '').trim().toLocaleLowerCase('ru');
  if (!expectedParent && !expectedChild) return true;
  const profile = buildProfileFromReportRow_(row || []);
  const parent = String(profile.parentName || '').trim().toLocaleLowerCase('ru');
  const child = String(profile.childName || '').trim().toLocaleLowerCase('ru');
  return (!expectedParent || parent === expectedParent) && (!expectedChild || child === expectedChild);
}

function parentDeletionCheckpointKey_(operationId) {
  return 'PARENT_DELETION_PROGRESS_' + String(operationId || '').trim();
}

function loadParentDeletionCheckpoint_(operationId) {
  const raw = PropertiesService.getScriptProperties().getProperty(parentDeletionCheckpointKey_(operationId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && value.version === 1 && value.operationId === operationId ? value : null;
  } catch (_) { return null; }
}

function saveParentDeletionCheckpoint_(checkpoint) {
  PropertiesService.getScriptProperties().setProperty(
    parentDeletionCheckpointKey_(checkpoint.operationId), JSON.stringify(checkpoint)
  );
}

function createParentDeletionCheckpoint_(operationId, phone10, expectedProfile, sheet, values) {
  const rowIndexes = [];
  values.forEach(function(row, index) {
    if (last10_(row[0]) === phone10) rowIndexes.push(index);
  });
  if (rowIndexes.length && expectedProfile && !rowIndexes.some(function(index) {
    return deletionProfileMatchesExpected_(values[index], expectedProfile);
  })) return { error:'RECORD_CHANGED', message:'Данные ребёнка изменились после запроса удаления; автоматическое удаление остановлено.' };

  const removedRows = rowIndexes.map(function(index) { return values[index]; });
  let removedTargets = removedRows.map(rawReportChildTargetFromReportRow_).filter(Boolean);
  if (!removedRows.length) {
    // A new parent is created in D1 first; the Sheets mirror runs in the
    // background. If an educator removes that profile before the mirror is
    // materialized, the deletion queue still carries the parent's full child
    // name. Use it only when it yields a name plus surname prefix; otherwise
    // stop rather than guessing which raw-report block belongs to the child.
    const fromRegistration = rawReportChildTargetFromProfileSnapshot_({
      childName:String(expectedProfile && expectedProfile.childName || '').trim()
    });
    if (!fromRegistration) {
      return { error:'CHECKPOINT_UNRECOVERABLE', message:'Ребёнка нет в таблице, а полного имени не хватает, чтобы безопасно найти его блок в сыром отчёте.' };
    }
    removedTargets = [fromRegistration];
  }
  const activeTargets = values.filter(function(row) { return last10_(row[0]) !== phone10; })
    .map(rawReportChildTargetFromReportRow_).filter(Boolean);
  const rawTargets = rawReportTargetsNoLongerActive_(removedTargets, activeTargets);
  const targetBases = {};
  rawTargets.forEach(function(target) { targetBases[target.baseKey] = true; });
  const rawGuardTargets = activeTargets.filter(function(target) { return !!targetBases[target.baseKey]; });
  const first = removedRows[0] || [];
  const admission = rawReportOwnershipProperty_('REPORT_ADMISSION_' + phone10) || 'legacy';
  const checkpoint = {
    version:1,
    operationId:operationId,
    phone10:phone10,
    parentName:String(first[1] || expectedProfile && expectedProfile.parentName || '').trim(),
    childName:String(first[2] || expectedProfile && expectedProfile.childName || '').trim(),
    admissionToken:admission,
    rowIdentity:removedRows.map(function(row) {
      return [last10_(row[0]), String(row[1] || '').trim(), String(row[2] || '').trim(), String(row[3] || '').trim()];
    }),
    rawTargets:rawTargets,
    rawGuardTargets:rawGuardTargets,
    steps:{ d1:false, raw:false, reports:false, inactivity:false, contact:false },
    createdAt:Date.now(),
    updatedAt:Date.now(),
    result:{ deletedReportRows:0, deletedRawReportBlocks:0, deletedD1Profiles:0 }
  };
  saveParentDeletionCheckpoint_(checkpoint);
  return { checkpoint:checkpoint, rowIndexes:rowIndexes };
}

function currentDeletionRowsMatchCheckpoint_(values, phone10, checkpoint, expectedProfile) {
  const current = [];
  values.forEach(function(row) { if (last10_(row[0]) === phone10) current.push(row); });
  if (!current.length) return true;
  const admission = rawReportOwnershipProperty_('REPORT_ADMISSION_' + phone10) || 'legacy';
  if (admission !== checkpoint.admissionToken) return false;
  if (expectedProfile && !current.some(function(row) { return deletionProfileMatchesExpected_(row, expectedProfile); })) return false;
  const expectedRows = checkpoint.rowIdentity || [];
  return current.every(function(row) {
    return expectedRows.some(function(identity) {
      return identity[0] === phone10 && identity[1] === String(row[1] || '').trim() &&
        identity[2] === String(row[2] || '').trim() && identity[3] === String(row[3] || '').trim();
    });
  });
}

function deleteReportChildByPhoneCore_(phoneRaw, expectedProfileRaw, operationIdRaw) {
  try {
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok:false, message:'Не удалось определить номер родителя.' };

    return withChatWriteLock_(function() {
      const sh = getDataSheet_();
      const operationId = String(operationIdRaw || '').trim();
      const hasCheckpoint = !!operationId;
      const lastRow = sh ? sh.getLastRow() : 0;
      const values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, 4).getValues() : [];
      let checkpoint = hasCheckpoint ? loadParentDeletionCheckpoint_(operationId) : null;
      let rowIndexes = [];
      if (hasCheckpoint && !checkpoint) {
        const created = createParentDeletionCheckpoint_(operationId, phone10, expectedProfileRaw, sh, values);
        if (created.error) return { ok:false, code:created.error, message:created.message };
        checkpoint = created.checkpoint;
        rowIndexes = created.rowIndexes;
      } else if (!hasCheckpoint) {
        values.forEach(function(row, index) { if (last10_(row[0]) === phone10) rowIndexes.push(index); });
      }

      if (checkpoint && checkpoint.phone10 !== phone10) return { ok:false, code:'OPERATION_MISMATCH', message:'Операция удаления привязана к другому профилю.' };
      if (checkpoint && checkpoint.steps && checkpoint.steps.complete) {
        return Object.assign({ ok:true, cleanupComplete:true, coreComplete:true, pendingSteps:[] }, checkpoint.result, { operationId:operationId, replayed:true });
      }
      if (checkpoint && !currentDeletionRowsMatchCheckpoint_(values, phone10, checkpoint, expectedProfileRaw)) {
        return { ok:false, code:'RECORD_CHANGED', message:'Профиль изменился после начала удаления; новая запись не затронута.' };
      }

      const errors = [];
      let deletedReportRows = 0;
      let deletedRawReportBlocks = 0;
      let deletedD1Profiles = 0;
      const persist = function() { checkpoint.updatedAt = Date.now(); saveParentDeletionCheckpoint_(checkpoint); };
      if (!checkpoint || !checkpoint.steps.d1) {
        try {
          const d1Cleanup = deleteD1ProfileWithS3Purge_(phone10);
          deletedD1Profiles = Number(d1Cleanup && d1Cleanup.deleted && 1 || 0);
          if (checkpoint) {
            checkpoint.steps.d1 = true;
            checkpoint.result.deletedD1Profiles = deletedD1Profiles;
            persist();
          }
        } catch (e) {
          return { ok:false, message:'Не удалось закрыть чат родителя. Удаление будет повторено: ' + String(e && e.message || e) };
        }
      }

      if (!checkpoint || !checkpoint.steps.raw) {
        try {
          const currentRows = sh && sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues() : [];
          const activeTargets = currentRows.filter(function(row) { return last10_(row[0]) !== phone10; })
            .map(rawReportChildTargetFromReportRow_).filter(Boolean);
          const targets = checkpoint ? checkpoint.rawTargets || [] : rowIndexes.map(function(index) { return rawReportChildTargetFromReportRow_(values[index]); }).filter(Boolean);
          const allTargets = (checkpoint ? checkpoint.rawGuardTargets || [] : []).concat(activeTargets, targets);
          const rawCleanup = applyRawReportCleanup_(prepareRawReportCleanupForChildren_(targets, allTargets));
          deletedRawReportBlocks = Number(rawCleanup.removedBlocks || 0);
          if (checkpoint) { checkpoint.steps.raw = true; checkpoint.result.deletedRawReportBlocks = deletedRawReportBlocks; persist(); }
        } catch (e) {
          errors.push('raw reports: ' + String(e && e.message || e));
        }
      }

      if (!checkpoint || !checkpoint.steps.reports) {
        try {
          const latest = sh && sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues() : [];
          const toDelete = [];
          latest.forEach(function(row, index) {
            if (last10_(row[0]) !== phone10) return;
            if (checkpoint && !(checkpoint.rowIdentity || []).some(function(identity) {
              return identity[0] === phone10 && identity[1] === String(row[1] || '').trim() && identity[2] === String(row[2] || '').trim() && identity[3] === String(row[3] || '').trim();
            })) throw new Error('Профиль изменился после начала удаления; новая запись сохранена.');
            toDelete.push(index + 2);
          });
          for (let i = toDelete.length - 1; i >= 0; i -= 1) sh.deleteRow(toDelete[i]);
          deletedReportRows = toDelete.length;
          if (checkpoint) { checkpoint.steps.reports = true; checkpoint.result.deletedReportRows = deletedReportRows; persist(); }
        } catch (e) { errors.push('REPORTS: ' + String(e && e.message || e)); }
      }

      if (!checkpoint || !checkpoint.steps.inactivity) {
        try { removeReportInactivityState_(phone10); if (checkpoint) { checkpoint.steps.inactivity = true; persist(); } }
        catch (e) { errors.push('report inactivity state: ' + String(e && e.message || e)); }
      }
      if (!checkpoint || !checkpoint.steps.contact) {
        try {
          const contact = checkpoint
            ? removeMedsiParentContactByPhone_(phone10)
            : removeMedsiParentContactBestEffort_(phone10);
          if (!contact || contact.ok !== false) { if (checkpoint) { checkpoint.steps.contact = true; persist(); } }
          else errors.push('parent contact: cleanup did not complete');
        } catch (e) { errors.push('parent contact: ' + String(e && e.message || e)); }
      }

      const pendingSteps = checkpoint ? Object.keys(checkpoint.steps).filter(function(step) { return step !== 'complete' && !checkpoint.steps[step]; }) : errors.length ? ['cleanup'] : [];
      const coreComplete = checkpoint ? checkpoint.steps.d1 && checkpoint.steps.raw && checkpoint.steps.reports : !errors.length;
      const cleanupComplete = coreComplete && (!checkpoint || checkpoint.steps.inactivity && checkpoint.steps.contact) && errors.length === 0;
      if (checkpoint && cleanupComplete) { checkpoint.steps.complete = true; checkpoint.result.completedAt = Date.now(); persist(); }
      return {
        ok:true,
        operationId:operationId || undefined,
        alreadyDeleted:checkpoint ? Number(checkpoint.result.deletedReportRows || 0) === 0 : rowIndexes.length === 0,
        deletedReportRows:Number(checkpoint ? checkpoint.result.deletedReportRows || 0 : deletedReportRows),
        deletedRawReportBlocks:Number(checkpoint ? checkpoint.result.deletedRawReportBlocks || 0 : deletedRawReportBlocks),
        deletedChatRows:0,
        deletedD1Profiles:Number(checkpoint ? checkpoint.result.deletedD1Profiles || 0 : deletedD1Profiles),
        coreComplete:!!coreComplete,
        cleanupComplete:!!cleanupComplete,
        pendingSteps:pendingSteps,
        cleanupErrors:errors
      };
    });
  } catch (e) {
    return { ok:false, message:'Не удалось удалить ребёнка: ' + (e.message || e) };
  }
}

function deleteReportChildByPhone(phoneRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
  } catch (e) {
    return { ok:false, message:'Не удалось удалить ребёнка: ' + (e.message || e) };
  }
  return deleteReportChildByPhoneCore_(phoneRaw, null);
}

function processParentDeletionFromCloudflare_(paramRaw) {
  const param = paramRaw || {};
  const operationId = String(param.operationId || '').trim();
  if (!/^delete_[A-Za-z0-9_-]{12,115}$/.test(operationId)) {
    return { ok:false, message:'Некорректный идентификатор удаления.' };
  }
  const result = deleteReportChildByPhoneCore_(param.phone, {
    parentName:String(param.parentName || '').trim(),
    childName:String(param.childName || '').trim()
  }, operationId);
  if (!result || result.ok !== true) return result || { ok:false, message:'Удаление не завершено.' };
  return Object.assign({}, result, {
    operationId:operationId,
    processing:false
  });
}

function getChatPhotosFolder_() {
  const folders = DriveApp.getFoldersByName(CHAT_PHOTOS_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(CHAT_PHOTOS_FOLDER_NAME);
}


function withChatWriteLock_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}


function parseReplyContext_(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(String(raw));
    const messageKey = String(parsed.messageKey || '').trim();
    if (!messageKey) return null;
    return {
      messageKey,
      side: String(parsed.side || '').trim(),
      type: String(parsed.type || 'text').trim(),
      text: String(parsed.text || '').slice(0, 240)
    };
  } catch (_) {
    return null;
  }
}

function normalizeReaction_(reactionRaw) {
  const allowed = ['❤️','👍','👌','🙏','🥰','😁'];
  const reaction = String(reactionRaw || '').trim();
  if (!reaction) return '';
  return allowed.includes(reaction) ? reaction : '';
}

function buildChatPreviewText_(type, cellValue) {
  const raw = String(cellValue || '').trim();
  if (type === 'image') return '[Фотография]';
  if (type === 'video') return '[Видео]';
  if (!raw) return '';

  const cleaned = raw.replace(/\[([^\|\]]+)\|https?:\/\/[^\]]+\]/g, '$1').trim();
  const maxChars = 200;
  if (cleaned.length <= maxChars) return cleaned;

  const truncated = cleaned.substring(0, maxChars);
  const lastSpaceIdx = truncated.lastIndexOf(' ');
  const endText = lastSpaceIdx > 0 ? truncated.substring(0, lastSpaceIdx) : truncated;
  return endText.trim() + '...';
}


function getProfileByPhone_(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return null;

  if (!isPhoneActiveInReports_(phone10)) return null;

  const sh = getDataSheet_();

  if (sh) {
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      const values = sh.getRange(2, 1, lastRow - 1, 8).getValues(); // A:H, including admission ID
      const generationColumnReady = typeof REPORT_PARENT_GENERATION_HEADER_ !== 'undefined' &&
        sh.getMaxColumns && sh.getMaxColumns() >= 9 &&
        String(sh.getRange(1, 9).getValue() || '').trim() === REPORT_PARENT_GENERATION_HEADER_;
      const generations = generationColumnReady
        ? sh.getRange(2, 9, lastRow - 1, 1).getValues() : [];

      for (let index = 0; index < values.length; index++) {
        const r = values[index];
        if (last10_(r[0]) !== phone10) continue;

        return buildProfileFromReportRow_(r.concat(generations[index] ? generations[index][0] : ''));
      }
    }
  }

  // A Cloudflare-first registration may be active before its queued row has
  // been copied to REPORTS. Read its canonical profile from D1 in that window.
  try {
    const value = d1AdminRequest_('/admin/profile/' + encodeURIComponent(phone10), 'get');
    const profile = value && value.profile;
    if (profile && last10_(profile.phone) === phone10) return profile;
  } catch (_) {}

  // CHAT_MESSAGES is historical content, never a profile authority. A failed
  // modern lookup must remain unavailable instead of resurrecting old names.

  return null;
}


/**
 * Получить только чаты с непрочитанными сообщениями для воспитателя
 */


/**
 * Получить только прочитанные чаты
 */


// Keeps the old Apps Script UI contract while making D1 the only write that
// determines success.  The Worker itself schedules push strictly after the
// insert, so legacy clients cannot produce a Sheets-only/push-only message.
function legacyD1MessageResult_(result) {
  if (!result || !result.ok || !result.message) {
    return result || { ok:false, message:'Не удалось сохранить сообщение в чате.' };
  }

  const message = result.message;
  return {
    ok: true,
    messageKey: String(message.messageKey || ''),
    timestamp: humanTime_(new Date(Number(message.timestamp || Date.now()))),
    type: String(message.type || 'text'),
    text: String(message.text || ''),
    fileId: String(message.fileId || '')
  };
}

function sendParentChatMessage(phoneRaw, textRaw, replyToKeyRaw, parentSessionRaw) {
  try {
    requireParentAccess_(phoneRaw, parentSessionRaw);
    const text = cleanIncomingText_(textRaw);
    if (!isPhoneActiveInReports_(phoneRaw)) {
      return { ok: false, message: 'Чат больше недоступен.' };
    }
    if (!text) return { ok: false, message: 'Пустое сообщение.' };

    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Ваш номер не найден в системе.' };
    }

    return legacyD1MessageResult_(
      sendD1MessageForParent(phoneRaw, {
        type: 'text',
        text: text,
        replyToKey: String(replyToKeyRaw || '')
      }, parentSessionRaw)
    );

  } catch (e) {
    return { ok: false, message: 'Ошибка отправки сообщения: ' + (e.message || e) };
  }
}

function sendEducatorChatMessage(phoneRaw, textRaw, replyToKeyRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const text = cleanIncomingText_(textRaw);

    if (!isPhoneActiveInReports_(phoneRaw)) {
      return { ok: false, message: 'Диалог с родителем был закрыт.' };
    }
    if (!text) return { ok: false, message: 'Пустое сообщение.' };

    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Не удалось определить чат по номеру телефона.' };
    }

    return legacyD1MessageResult_(
      sendD1MessageForEducator(phoneRaw, {
        type: 'text',
        text: text,
        replyToKey: String(replyToKeyRaw || '')
      }, tutorTokenRaw)
    );

  } catch (e) {
    return { ok: false, message: 'Ошибка отправки ответа: ' + (e.message || e) };
  }
}


function listAvailableParentsForChat(tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const sh = getDataSheet_();
    if (!sh) return { ok: false, message: 'Лист REPORTS не найден.' };

    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, rows: [] };

    const values = sh.getRange(2, 1, lastRow - 1, 7).getValues();
    const byPhone = {};

    values.forEach(r => {
      const phone = normalizePhone_(r[0]);
      const phone10 = last10_(phone);
      const parentName = String(r[1] || '').trim();
      const childC = String(r[2] || '').trim();
      const famD = String(r[3] || '').trim();
      if (!phone10) return;

      const childBase = stripInitialFromName_(childC) || childC;
      const childName = [childBase, famD].filter(Boolean).join(' ').trim();

      if (!byPhone[phone10]) {
        byPhone[phone10] = {
          phone,
          parentName,
          childName
        };
      }
    });

    const rows = enrichProfilesWithRelationships_(Object.values(byPhone), values).sort((a, b) => {
      const aChild = String(a.childName || '').toLowerCase();
      const bChild = String(b.childName || '').toLowerCase();
      return aChild.localeCompare(bChild, 'ru');
    });

    return { ok: true, rows };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки родителей: ' + (e.message || e) };
  }
}

function hasUnreadEducatorMessages(phoneRaw) {
  try {
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok: false, hasUnread: false };
    // D1 is the only source of truth for chat state.  Do not fall back to the
    // retired CHAT_MESSAGES/CHAT_INDEX sheets: that can show a stale badge
    // after the browser has already marked the D1 thread as read.
    const result = getD1ParentUnreadState_(phone10);
    return { ok: true, hasUnread: !!result.hasUnread };

  } catch (e) {
    return { ok: false, hasUnread: false, message: 'Ошибка проверки новых сообщений: ' + (e.message || e) };
  }
}

function markEducatorMessagesAsRead(phoneRaw, parentSessionRaw) {
  try {
    requireParentAccess_(phoneRaw, parentSessionRaw);
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok: false };
    // The visible parent chat already marks the D1 thread directly.  Keep
    // this Apps Script API as a compatibility entry point, but make it update
    // the same D1 state instead of the retired Sheets mirror.
    return markD1ParentMessagesRead_(phone10);

  } catch (e) {
    return { ok: false, message: 'Ошибка отметки сообщений: ' + (e.message || e) };
  }
}


/** ========= Утилиты ========= **/
function getDatabaseSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(DATABASE_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(DATABASE_SHEET_NAME);
  return sh;
}

function findFirstEmptyRowInColA_(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 2;

  const col = sh.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  for (let i = 0; i < col.length; i++) {
    if (!String(col[i] || '').trim()) return i + 2;
  }
  return lastRow + 1;
}

function appendToDatabase_(phone, parentFirst, childFirst, familyForStore) {
  const sh = getDatabaseSheet_();

  const phone10 = last10_(phone);
  const lastRow = sh.getLastRow();

  if (lastRow >= 2) {
    const phones = sh.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    const exists = phones.some(p => last10_(p) === phone10);
    if (exists) return;
  }

  // DATABASE mirrors the registration spelling too. Name equivalence is only
  // for matching report headers; it is not a data-normalization rule.
  const childStoredBase = stripInitialFromName_(childFirst) || String(childFirst || '').trim();

  const row = findFirstEmptyRowInColA_(sh);
  sh.getRange(row, 1, 1, 4).setValues([[
    phone,
    parentFirst,
    childStoredBase,
    familyForStore
  ]]);
}

function normalizePhone_(raw) {
  let phone = String(raw || '').replace(/\D+/g, '');
  if (phone.startsWith('7')) phone = '8' + phone.slice(1);
  if (phone.length === 10) phone = '8' + phone;
  return phone;
}

function onlyDigits_(v) {
  return String(v == null ? '' : v).replace(/\D+/g, '');
}

function nowTs_() {
  return Date.now();
}

function getLatestReport(sheet, colIndex = 1) {
  if (!sheet) return "";
  // Both the website and manual edits publish the current raw report in A1.
  // Historical or incidental cells below it must never override that source.
  return sheet.getRange(1, colIndex).getValue() || "";
}

function splitBlocksByChildren(text, childrenVariants) {
  const blocks = {};
  if (!text) return blocks;

  function norm(n) {
    return String(n || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .normalize('NFD')
      .replace(/ь/g, '')
      .replace(/ъ/g, '')
      .replace(/[^а-яa-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const EXCL = /[!！‼️❗️❗❕❕]+/g;

  let clean = String(text)
    .replace(EXCL, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  clean = clean.replace(
    /(^|\n)\s*№?\s*(50[1-9]|51[0-2])\s*(?=\n|$)/g,
    ''
  );

  clean = clean
    .replace(/(\b\d{1,2})\s*:\s*(\d{2})(\b)/g, '$1:$2$3')
    .replace(/(\b\d{1,2})\s*:\s*(\d{2})\s*:\s*(\d{2})(\b)/g, '$1:$2:$3$4');

  const index = {};
  const baseInitial = {};
  const baseOrder  = {};

  function addIndexKey_(key, base) {
    if (!key) return;
    if (!index[key]) index[key] = new Set();
    index[key].add(base);
  }

  childrenVariants.forEach((variants, idx) => {
    const base = variants?.[0] || '';
    if (!base) return;

    baseOrder[base] = idx;

    const baseCleanForInit = String(base || '').trim().replace(/[.]+$/g, '').trim();
    const initMatch = baseCleanForInit.match(/\s+([А-ЯЁ])\s*$/);
    baseInitial[base] = initMatch ? initMatch[1].toUpperCase() : '';

    const all = new Set();
    (variants || []).forEach(v => {
      const s = norm(v);
      if (!s) return;
      all.add(s);
      all.add(s.replace(/\s+/g, ''));
    });

    all.forEach(k => addIndexKey_(k, base));
  });

  const headerRe = /(^|\n)\s*([^:\-–—\n]+?)\s*(?:\.?\s*[:\-–—])\s*/g;
  const parts = [];
  let m;
  while ((m = headerRe.exec(clean)) !== null) {
    parts.push({
      nameRaw: m[2].trim(),
      start: m.index,
      bodyStart: headerRe.lastIndex
    });
  }

  if (parts.length === 0) {
    for (const v of childrenVariants) {
      if (v?.length) blocks[v[0]] = "Пока ещё нет отчёта 🙏";
    }
    return blocks;
  }

  for (let i = 0; i < parts.length; i++) {
    const { nameRaw, bodyStart } = parts[i];
    const bodyEnd = (i + 1 < parts.length) ? parts[i + 1].start : clean.length;
    const body = clean.slice(bodyStart, bodyEnd).trim();

    const nameClean = String(nameRaw || '').replace(EXCL, '').trim();
    const nameCleanForInit = nameClean
      .replace(/\.\s*$/g, '')
      .replace(/\.\s+(?=[:\-–—])/g, '')
      .trim();

    const nameNorm = norm(nameClean);
    const nameNoSpace = nameNorm.replace(/\s+/g, '');

    const headerInitMatch = nameCleanForInit.match(/\s+([А-ЯЁ])\s*$/);
    const headerInitial = headerInitMatch ? headerInitMatch[1].toUpperCase() : '';

    const candSet = new Set();
    (index[nameNorm] || []).forEach(b => candSet.add(b));
    (index[nameNoSpace] || []).forEach(b => candSet.add(b));

    let candidates = [...candSet];

    if (headerInitial && candidates.length > 0) {
      let filtered = candidates.filter(b => {
        const bi = baseInitial[b] || '';
        return (!bi || bi === headerInitial);
      });

      if (filtered.length === 0) {
        const stripped = norm(
          nameCleanForInit.replace(/\s+[А-ЯЁ]\s*$/, '').trim()
        );
        const strippedNoSpace = stripped.replace(/\s+/g, '');
        (index[stripped] || []).forEach(b => candSet.add(b));
        (index[strippedNoSpace] || []).forEach(b => candSet.add(b));

        filtered = [...candSet].filter(b => {
          const bi = baseInitial[b] || '';
          return (!bi || bi === headerInitial);
        });
      }

      candidates = filtered;
    }

    if (candidates.length === 0) continue;

    if (!headerInitial && candidates.length > 1) {
      candidates.sort((a, b) => (baseOrder[a] || 0) - (baseOrder[b] || 0));
      candidates = [candidates[0]];
    }

    if (candidates.length > 1) {
      candidates.sort((a, b) => (baseOrder[a] || 0) - (baseOrder[b] || 0));
      candidates = [candidates[0]];
    }

    const winner = candidates[0];
    if (winner) {
      blocks[winner] = `${winner}: ${body}`;
    }
  }

  for (const v of childrenVariants) {
    const main = v?.[0];
    if (main && !blocks[main]) blocks[main] = "Пока ещё нет отчёта 🙏";
  }

  return blocks;
}


function buildKnownBaseKeys_(children) {
  const keys = {};
  (children || []).forEach(child => {
    if (child.baseKey) keys[child.baseKey] = true;
  });
  return keys;
}

function getFamilyInitialSuffix_(familyRaw) {
  const m = String(familyRaw || '').trim().match(/^([A-ZА-ЯЁ])/i);
  return m ? m[1].toUpperCase() : '';
}

function stripStoredFamilyQualifier_(nameRaw, familyRaw) {
  const name = String(nameRaw || '').trim();
  if (!name) return '';
  const suffix = getSuffixToken_(name);
  const familyKey = normalizeFamilyName_(familyRaw);
  const suffixKey = normalizeSuffixKey_(suffix);
  // C may still contain a legacy initial or a short surname prefix. Remove it
  // only when D proves it belongs to this child's surname. This also keeps
  // compound first names and unrelated trailing words intact.
  if (suffix && suffixKey.length <= 4 && familyKey && familyKey.indexOf(suffixKey) === 0) {
    return stripInitialFromName_(name) || name;
  }
  return name;
}

function normalizeReportChildName_(nameRaw, familyRaw) {
  const name = String(nameRaw || '').trim();
  if (!name) return '';
  const baseName = stripStoredFamilyQualifier_(name, familyRaw) || name;
  const suffix = getFamilyInitialSuffix_(familyRaw);
  return suffix ? `${baseName} ${suffix}` : baseName;
}

function addFamilyInitialToName_(nameRaw, familyRaw) {
  return normalizeReportChildName_(nameRaw, familyRaw);
}

function normalizeReportChildNames_(dataSheet, names, families) {
  if (!dataSheet || !names || !names.length) return names;
  // This helper builds the report-matching form in memory. Never rewrite C as
  // a side effect of report distribution; C stores the registered first name.
  return names.map((name, index) => normalizeReportChildName_(name, families[index]) || name);
}

function escapeRegExp_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeLegacyDistributionLogSheet_() {
  const ss = getSpreadsheet_();
  const sh = ss.getSheetByName('DISTRIBUTION_LOG');
  if (sh) ss.deleteSheet(sh);
}

function buildReportChildren_(baseNames, families) {
  return baseNames.map((fullName, index) => {
    const name = String(fullName || '').trim();
    const suffix = getSuffixToken_(name) || getFamilyInitialSuffix_(families[index]);
    const baseKey = getNameBaseKey_(name);
    const phone = '';

    return {
      index,
      fullName: name,
      baseName: stripInitialFromName_(name),
      displayNameKey: normalizeName_(stripInitialFromName_(name)),
      baseKey,
      suffix,
      suffixKey: normalizeSuffixKey_(suffix),
      family: String(families[index] || '').trim(),
      phone,
      identityKey: normalizeSuffixKey_(suffix) || ('row:' + index)
    };
  });
}

function attachPhonesToReportChildren_(children, dataSheet, count) {
  if (!dataSheet || count <= 0) return children;

  const phones = dataSheet.getRange(2, 1, count, 1).getValues().flat();
  let admissionIds = [];
  try { admissionIds = dataSheet.getRange(2, REPORT_CHILD_ADMISSION_COLUMN_, count, 1).getValues().flat(); }
  catch (_) { admissionIds = []; }
  children.forEach((child, i) => {
    const phone = normalizePhone_(phones[i]);
    child.phone = phone;
    child.phone10 = last10_(phone);
    child.childAdmissionId = String(admissionIds[i] || '').trim();
    if (!child.suffixKey) child.identityKey = 'phone:' + (child.phone10 || child.index);
  });

  return children;
}

function buildDistributionContext_(children, parsedReports) {
  const byBase = {};

  children.forEach(child => {
    if (!child.baseKey) return;
    if (!byBase[child.baseKey]) {
      byBase[child.baseKey] = {
        registered: [],
        activeIdentityKeys: {}
      };
    }

    byBase[child.baseKey].registered.push(child);
    byBase[child.baseKey].activeIdentityKeys[child.identityKey] = true;
  });

  return byBase;
}

// NAME_VARIANTS links spellings, not a licence to cross explicit male/female
// forms. Neutral nicknames (Саша, Женя, Валя) provide no gender evidence.
function explicitReportNameGender_(nameRaw) {
  const name = normalizeName_(stripInitialFromName_(nameRaw));
  if (['саша', 'саня', 'шура', 'женя', 'валя'].indexOf(name) >= 0) return '';
  if (typeof medsiContactGender_ === 'function') {
    const gender = medsiContactGender_(name);
    if (gender === 'male' || gender === 'female') return gender;
  }
  if (['александр', 'евгений', 'валентин'].indexOf(name) >= 0) return 'male';
  if (['александра', 'евгения', 'валентина'].indexOf(name) >= 0) return 'female';
  return '';
}

function reportChildGenderEvidence_(child) {
  const explicit = explicitReportNameGender_(child && (child.fullName || child.baseName));
  if (explicit) return explicit;
  const family = normalizeFamilyName_(child && child.family);
  if (/(ова|ева|ина|ына|ская|цкая|ая|яя)$/.test(family)) return 'female';
  if (/(ов|ев|ин|ын|ский|цкий|ый|ий)$/.test(family)) return 'male';
  return '';
}

function reportChildIdentityKey_(child) {
  if (!child) return '';
  return [
    child.baseKey || '',
    child.suffixKey || '',
    normalizeFamilyName_(child.family || ''),
    reportChildGenderEvidence_(child)
  ].join('|');
}

function areSameReportChild_(children) {
  if (!children || children.length === 0) return false;
  const key = reportChildIdentityKey_(children[0]);
  return !!key && children.every(child => reportChildIdentityKey_(child) === key);
}

function findReportChildrenByFamilyPrefix_(children, prefixRaw) {
  const prefix = normalizeFamilyName_(prefixRaw);
  // Одна буква — это обычный инициал. Для различения фамилий принимаем
  // короткое начало из 2–4 букв: «Бы», «Быч», «Бычк».
  if (prefix.length < 2 || prefix.length > 4) return [];

  return (children || []).filter(child => {
    const family = normalizeFamilyName_(child && child.family);
    return !!family && family.indexOf(prefix) === 0;
  });
}

function okReportChildren_(children, reason) {
  const list = (children || []).filter(Boolean);
  return {
    status: 'ok',
    child: list[0] || null,
    children: list,
    reason
  };
}

function resolveReportBlock_(block, contextByBase) {
  if (block && block.forcedResolution) return block.forcedResolution;

  const ctx = contextByBase[block.baseKey] || {
    registered: [],
    activeIdentityKeys: {}
  };

  let candidates = ctx.registered.filter(child => child.baseKey === block.baseKey);
  const headerGender = explicitReportNameGender_(block.baseRaw || block.rawName);
  if (headerGender) {
    const compatible = candidates.filter(function(child) {
      const gender = reportChildGenderEvidence_(child);
      return !gender || gender === headerGender;
    });
    if (candidates.length && !compatible.length) {
      return { status:'ambiguous', child:null,
        reason:'Мужская и женская формы имени не взаимозаменяемы; проверьте ребёнка и фамилию.' };
    }
    candidates = compatible;
  }

  // NAME_VARIANTS makes all linked spellings equivalent for identity matching.
  // Do not narrow by the spelling written in the raw report: an exact-name
  // child may coexist with another child registered under an alias (for
  // example "Саша Б." and "Александра К."). Surname initials disambiguate;
  // a bare shared alias remains ambiguous below.

  if (block.hasSuffix) {
    const exactCandidates = candidates.filter(child => child.suffixKey && child.suffixKey === block.suffixKey);

    if (exactCandidates.length === 1) {
      return { status: 'ok', child: exactCandidates[0], reason: 'Точный заголовок с инициалом.' };
    }

    if (exactCandidates.length > 1) {
      if (areSameReportChild_(exactCandidates)) {
        return okReportChildren_(exactCandidates, 'Точный заголовок совпал с одним ребёнком в нескольких родительских строках.');
      }

      return { status: 'ambiguous', child: null, reason: 'Один и тот же инициал подходит нескольким строкам REPORTS.' };
    }

    // Если первых букв фамилий недостаточно (две Саши Б.), воспитатель может
    // написать 2–4 первые буквы фамилии: «Саша Бы» / «Саша Быч». Сверяем их
    // с полной фамилией из REPORTS, не меняя красивое отображение «Саша Б.»
    // в таблице.
    const familyPrefixCandidates = findReportChildrenByFamilyPrefix_(candidates, block.suffixKey);
    if (familyPrefixCandidates.length === 1) {
      return {
        status: 'ok',
        child: familyPrefixCandidates[0],
        reason: 'Точный заголовок с началом фамилии.'
      };
    }

    if (familyPrefixCandidates.length > 1) {
      if (areSameReportChild_(familyPrefixCandidates)) {
        return okReportChildren_(familyPrefixCandidates, 'Начало фамилии совпало с одним ребёнком в нескольких родительских строках.');
      }

      return { status: 'ambiguous', child: null, reason: 'Начало фамилии подходит нескольким разным детям.' };
    }

    // A full surname can also identify the child, even though REPORTS stores
    // only its initial in the display name.
    const fullFamilyKey = normalizeFamilyName_(block.suffix);
    const fullFamilyCandidates = fullFamilyKey.length > 4
      ? candidates.filter(child => normalizeFamilyName_(child.family) === fullFamilyKey)
      : [];
    if (fullFamilyCandidates.length === 1) {
      return { status: 'ok', child: fullFamilyCandidates[0], reason: 'Точная фамилия из REPORTS.' };
    }
    if (fullFamilyCandidates.length > 1) {
      if (areSameReportChild_(fullFamilyCandidates)) {
        return okReportChildren_(fullFamilyCandidates, 'Фамилия совпала с одним ребёнком в нескольких родительских строках.');
      }
      return { status: 'ambiguous', child: null, reason: 'Фамилия подходит нескольким разным детям.' };
    }

    // An explicit different initial or surname must never fall back to the
    // only registered child with this first name.  Otherwise «Кирилл М.»
    // gets assigned to «Кирилл Ш.» and triggers a false duplicate-block error
    // or, worse, exposes the wrong child's report to a parent.
    return { status: 'no_parent', child: null, reason: 'Инициал или фамилия заголовка не совпадает с активной строкой REPORTS.' };
  }

  // Голое имя нельзя распределять, если в REPORTS есть ещё один другой
  // ребёнок с тем же именем и другим инициалом. Несколько строк одного
  // ребёнка (например, для двух родителей) здесь не блокируют распределение.
  if (candidates.length > 1 && !areSameReportChild_(candidates)) {
    return {
      status: 'ambiguous',
      child: null,
      reason: 'Голое имя совпадает с несколькими разными строками REPORTS; требуется инициал фамилии.'
    };
  }

  const activeCandidates = candidates;

  if (activeCandidates.length === 0) {
    return { status: 'no_parent', child: null, reason: 'Имя есть в сыром отчёте, но активной строки в REPORTS нет.' };
  }

  if (activeCandidates.length > 1) {
    if (areSameReportChild_(activeCandidates)) {
      return okReportChildren_(activeCandidates, 'Голое имя совпало с одним ребёнком в нескольких родительских строках.');
    }

    return { status: 'ambiguous', child: null, reason: 'Голое имя подходит нескольким активным строкам REPORTS.' };
  }

  return { status: 'ok', child: activeCandidates[0], reason: 'Единственный безопасный кандидат.' };
}

function reportDisplayNameForChild_(child) {
  if (!child) return '';
  const fullName = String(child.fullName || '').trim();
  return stripInitialFromName_(fullName) || String(child.baseName || '').trim() || fullName;
}

// A missing initial is recoverable only when every other same-named child
// has exactly one explicit, unambiguous block in this report. Parent rows
// for the same child count as one identity. Never infer two bare blocks.
function resolveReportBlocksByExclusion_(blocks, contextByBase) {
  const resolutions = blocks.map(function(block) { return resolveReportBlock_(block, contextByBase); });
  const groups = {};
  blocks.forEach(function(block, index) {
    if (!groups[block.baseKey]) groups[block.baseKey] = [];
    groups[block.baseKey].push(index);
  });
  Object.keys(groups).forEach(function(baseKey) {
    const indices = groups[baseKey];
    const bare = indices.filter(function(index) { return !blocks[index].hasSuffix; });
    // Report headers themselves are identity evidence. Removing a same-named
    // child from REPORTS must never make their bare block belong to the survivor.
    if (indices.length > 1) {
      bare.forEach(function(index) {
        if (resolutions[index].status === 'ok') {
          resolutions[index] = { status:'ambiguous', child:null,
            reason:'В отчёте несколько блоков с этим именем; неподписанный блок требует отдельного безопасного сопоставления.' };
        }
      });
    }
    if (bare.length !== 1 || resolutions[bare[0]].status !== 'ambiguous') return;
    const explicit = indices.filter(function(index) { return blocks[index].hasSuffix; });
    if (!explicit.length || explicit.some(function(index) { return resolutions[index].status !== 'ok'; })) return;
    const used = {};
    let duplicate = false;
    explicit.forEach(function(index) {
      const keys = uniqueReportChildrenByIdentity_(reportResolutionTargets_(resolutions[index]));
      if (keys.length !== 1) { duplicate = true; return; }
      const key = reportChildIdentityKey_(keys[0]);
      if (used[key]) duplicate = true;
      used[key] = true;
    });
    if (duplicate) return;
    const registered = contextByBase[baseKey] && contextByBase[baseKey].registered || [];
    const remaining = registered.filter(function(child) {
      const gender = explicitReportNameGender_(blocks[bare[0]].baseRaw || blocks[bare[0]].rawName);
      return !used[reportChildIdentityKey_(child)] && (!gender || !reportChildGenderEvidence_(child) || gender === reportChildGenderEvidence_(child));
    });
    if (uniqueReportChildrenByIdentity_(remaining).length !== 1) return;
    resolutions[bare[0]] = okReportChildren_(remaining, 'Единственный оставшийся ребёнок после явных заголовков отчёта.');
  });
  return resolutions;
}

function buildSafeDistribution_(reportType, parsed, contextByBase) {
  const byRow = {};

  const resolutions = resolveReportBlocksByExclusion_(parsed.blocks, contextByBase);
  const assignments = {};
  resolutions.forEach(function(resolution) {
    if (resolution.status !== 'ok') return;
    reportResolutionTargets_(resolution).forEach(function(target) {
      assignments[target.index] = Number(assignments[target.index] || 0) + 1;
    });
  });
  parsed.blocks.forEach((block, index) => {
    const res = resolutions[index];
    const targets = (res.children && res.children.length) ? res.children : (res.child ? [res.child] : []);
    const child = targets[0] || null;
    const reportName = child ? reportDisplayNameForChild_(child) : (block.rawName || '');
    const finalText = child ? `${reportName}: ${block.body}`.trim() : '';

    if (res.status === 'ok' && finalText) {
      targets.forEach(target => {
        if (assignments[target.index] !== 1) return;
        byRow[target.index] = finalText;
      });
    }
  });

  return { byRow };
}


// Cache one Properties read per execution, not one read per child/block on
// every minute tick; otherwise the safety check could exhaust the daily quota.
let RAW_REPORT_OWNERSHIP_PROPERTIES_CACHE_ = null;
function rawReportOwnershipProperty_(key) {
  const props = PropertiesService.getScriptProperties();
  if (typeof props.getProperties !== 'function') return props.getProperty(key); // Minimal test doubles.
  if (!RAW_REPORT_OWNERSHIP_PROPERTIES_CACHE_) RAW_REPORT_OWNERSHIP_PROPERTIES_CACHE_ = props.getProperties();
  return RAW_REPORT_OWNERSHIP_PROPERTIES_CACHE_[key] || '';
}
function cacheRawReportOwnershipProperty_(key, value) {
  if (RAW_REPORT_OWNERSHIP_PROPERTIES_CACHE_) RAW_REPORT_OWNERSHIP_PROPERTIES_CACHE_[key] = value;
}

// Ownership is keyed by normalized body + alias group, deliberately excluding
// the mutable initial/prefix/display spelling. Store hashes and contact keys,
// never report bodies. A new admission cannot inherit a previous owner's block.
function rawReportOwnershipKey_(kind, block) {
  return 'RAW_REPORT_OWNER_' + kind + '_' + reportFingerprint_(
    String(block.baseKey || '') + '\n' + normalizeReportBlockBody_(block.body)
  );
}

function rawReportOwnerIdentity_(child) {
  return reportFingerprint_(reportChildIdentityKey_(child));
}

function rawReportOwnerContactKey_(child) {
  const phone = last10_(child && (child.phone10 || child.phone));
  if (!phone) return '';
  const admission = rawReportOwnershipProperty_('REPORT_ADMISSION_' + phone) || 'legacy';
  return phone + '|' + admission;
}

function rawReportOwnerMatches_(owner, targets) {
  if (!owner || owner.blocked || !targets.length) return false;
  const identities = uniqueStrings_(targets.map(rawReportOwnerIdentity_));
  if (identities.length !== 1 || identities[0] !== owner.identity) return false;
  if (owner.childAdmissionId) {
    const admissionIds = uniqueStrings_(targets.map(function(child) { return String(child.childAdmissionId || '').trim(); }).filter(Boolean));
    return admissionIds.length === 1 && admissionIds[0] === owner.childAdmissionId;
  }
  return targets.some(function(child) { return (owner.phones || []).indexOf(rawReportOwnerContactKey_(child)) >= 0; });
}

function loadRawReportOwnershipRecords_(kind, parsed) {
  const records = {};
  ((parsed && parsed.blocks) || []).forEach(function(block) {
    const key = rawReportOwnershipKey_(kind, block);
    if (records[key] === undefined) records[key] = rawReportOwnershipProperty_(key);
  });
  return records;
}

// Pure ownership decision. Coordinators persist its proposed writes only after
// their source and roster barriers have passed.
function planRawReportOwnershipGuard_(kind, parsed, contextByBase, distribution, previousReports, allowNew, recordsRaw, nowRaw) {
  const records = recordsRaw || {};
  const guardedDistribution = {
    byRow:Object.assign({}, distribution && distribution.byRow || {})
  };
  const resolutions = resolveReportBlocksByExclusion_(parsed.blocks, contextByBase);
  const groups = {};
  parsed.blocks.forEach(function(block, index) {
    const key = rawReportOwnershipKey_(kind, block);
    (groups[key] || (groups[key] = [])).push(index);
  });
  const writes = {};
  const blockedRows = {};
  Object.keys(groups).forEach(function(key) {
    const indices = groups[key];
    const index = indices[0];
    const block = parsed.blocks[index];
    const resolution = resolutions[index];
    const targets = resolution.status === 'ok' ? reportResolutionTargets_(resolution) : [];
    let owner = null;
    const raw = records[key] || '';
    if (raw) {
      try { owner = JSON.parse(raw); }
      catch (_) { owner = { blocked:true }; }
    }
    const authored = allowNew && allowNew.headers && allowNew.headers[key];
    const explicitlyClarified = authored && authored.hasSuffix &&
      (String(authored.suffixKey || '').length >= 2 || explicitReportNameGender_(authored.baseRaw));
    // Only a deliberately clarified, newly submitted heading may release an
    // unowned quarantine. Canonicalizer-generated initials are not evidence.
    if (owner && owner.blocked && explicitlyClarified && targets.length && indices.length === 1) owner = null;
    // Ambiguous blocks remain quarantined even when a later discharge makes
    // the same short heading look unique. Only a new, identifiable block is safe.
    if (!owner) {
      const hasExistingAssignment = targets.some(function(child) {
        const previous = previousReports && previousReports[child.index];
        return isActualReportText_(previous) && comparableReportBody_(previous) === normalizeReportBlockBody_(block.body);
      });
      const phones = uniqueStrings_(targets.map(rawReportOwnerContactKey_).filter(Boolean));
      const identities = uniqueStrings_(targets.map(rawReportOwnerIdentity_));
      const admissionIds = uniqueStrings_(targets.map(function(child) { return String(child.childAdmissionId || '').trim(); }).filter(Boolean));
      owner = targets.length && phones.length && identities.length === 1 && indices.length === 1 && (allowNew || hasExistingAssignment)
        ? { identity:identities[0], phones:phones, childAdmissionId:admissionIds.length === 1 ? admissionIds[0] : '', at:Number(nowRaw) || 0 }
        : { blocked:true, at:Number(nowRaw) || 0 };
      writes[key] = JSON.stringify(owner);
    }
    indices.forEach(function(blockIndex) {
      const res = resolutions[blockIndex];
      const assigned = reportResolutionTargets_(res);
      if (res.status === 'ok' && rawReportOwnerMatches_(owner, assigned)) {
        // Another parent may join the same active child. Extend only while an
        // original owner contact is still present, never solely by short name.
        const phones = uniqueStrings_((owner.phones || []).concat(assigned.map(function(child) {
          return rawReportOwnerContactKey_(child);
        }).filter(Boolean)));
        if (phones.length !== (owner.phones || []).length) {
          owner.phones = phones;
          writes[key] = JSON.stringify(owner);
        }
        const admissionIds = uniqueStrings_(assigned.map(function(child) { return String(child.childAdmissionId || '').trim(); }).filter(Boolean));
        if (!owner.childAdmissionId && admissionIds.length === 1) {
          owner.childAdmissionId = admissionIds[0];
          writes[key] = JSON.stringify(owner);
        }
        return;
      }
      assigned.forEach(function(child) { blockedRows[child.index] = true; });
    });
  });
  Object.keys(blockedRows).forEach(function(row) { delete guardedDistribution.byRow[row]; });
  guardedDistribution.ownershipBlockedRows = Object.keys(blockedRows).length;
  return { distribution:guardedDistribution, proposedOwnershipWrites:writes, blockedRows:blockedRows };
}

function commitRawReportOwnershipWrites_(writesRaw) {
  const writes = writesRaw || {};
  const props = PropertiesService.getScriptProperties();
  // Persist before writing a parent-visible report. A property failure must
  // stop distribution instead of falling back to name-only routing.
  Object.keys(writes).forEach(function(key) {
    props.setProperty(key, writes[key]);
    cacheRawReportOwnershipProperty_(key, writes[key]);
  });
}

function logRawReportOwnershipPlan_(kind, plan) {
  const writes = plan && plan.proposedOwnershipWrites || {};
  const blockedRows = plan && plan.blockedRows || {};
  if (Object.keys(writes).length || Object.keys(blockedRows).length) {
    Logger.log('RAW_REPORT_OWNERSHIP_GUARD ' + JSON.stringify({ kind:kind, recorded:Object.keys(writes).length, blockedRows:Object.keys(blockedRows).length }));
  }
}

function applyRawReportOwnershipGuard_(kind, parsed, contextByBase, distribution, previousReports, allowNew) {
  const records = loadRawReportOwnershipRecords_(kind, parsed);
  const plan = planRawReportOwnershipGuard_(kind, parsed, contextByBase, distribution,
    previousReports, allowNew, records, Date.now());
  commitRawReportOwnershipWrites_(plan.proposedOwnershipWrites);
  logRawReportOwnershipPlan_(kind, plan);
  return plan.distribution;
}

function assertReportDistributionSourceUnchanged_(sheet, expectedRaw) {
  const current = String(getLatestReport(sheet, 1) || '');
  if (current !== String(expectedRaw || '')) {
    throw new Error('Исходный отчёт изменился во время расчёта; устаревшее распределение отменено.');
  }
}

// Final read barrier: even a concurrent staff row move cannot expose a body
// whose saved owner does not match this contact/child in REPORTS.
function rawReportRowOwnershipAllows_(kind, row) {
  const child = buildReportChildren_([normalizeReportChildName_(row[2], row[3])], [row[3]])[0];
  child.phone10 = last10_(row[0]);
  child.childAdmissionId = String(row[7] || '').trim();
  const text = row[kind === 'morning' ? 4 : 5];
  const key = rawReportOwnershipKey_(kind, { baseKey:child.baseKey, body:comparableReportBody_(text) });
  const raw = rawReportOwnershipProperty_(key);
  if (!raw) return false;
  try { return rawReportOwnerMatches_(JSON.parse(raw), [child]); }
  catch (_) { return false; }
}

function assertReportDistributionRosterUnchanged_(sheet, children, count) {
  if (Math.max(sheet.getLastRow() - 1, 0) !== count) throw new Error('Список детей изменился; распределение будет повторено.');
  const current = sheet.getRange(2, 1, count, 4).getValues();
  let currentAdmissionIds = [];
  try { currentAdmissionIds = sheet.getRange(2, REPORT_CHILD_ADMISSION_COLUMN_, count, 1).getValues().flat(); }
  catch (_) { currentAdmissionIds = []; }
  if (current.some(function(row, index) {
    const child = children[index];
    return last10_(row[0]) !== last10_(child.phone10 || child.phone) ||
      normalizeReportChildName_(row[2], row[3]) !== child.fullName ||
      normalizeFamilyName_(row[3]) !== normalizeFamilyName_(child.family) ||
      String(currentAdmissionIds[index] || '').trim() !== String(child.childAdmissionId || '').trim();
  })) throw new Error('Строки REPORTS изменились; распределение будет повторено.');
}

function rememberRawReportPublicationOwnership_(kind, text, authoredRaw) {
  if (['morning', 'evening'].indexOf(kind) < 0) return;
  const children = buildReportValidationChildren_();
  if (!children.length) return;
  const context = buildDistributionContext_(children, []);
  const known = buildKnownBaseKeys_(children);
  const parsed = parseReportBlocks_(text, known, context);
  const authored = parseReportBlocks_(String(authoredRaw || ''), known, context);
  const headers = {};
  authored.blocks.forEach(function(block) { headers[rawReportOwnershipKey_(kind, block)] = block; });
  const guarded = applyRawReportOwnershipGuard_(kind, parsed, context, { byRow:{} }, [], { headers:headers });
  if (guarded.ownershipBlockedRows) {
    throw new Error('Отчёт не сохранён: один из блоков связан с другим ребёнком или прошлым поступлением. Проверьте текст и полную фамилию; старый отчёт нельзя передавать новому ребёнку.');
  }
}

function buildReportChildrenFromProfileSnapshot_(snapshotRaw) {
  const snapshot = snapshotRaw || {};
  const entries = Object.keys(snapshot).sort().map(function(phoneKey) {
    const profile = snapshot[phoneKey] || {};
    let displayName = String(profile.reportChildName || '').trim();
    let family = String(profile.familyName || '').trim();

    if (!displayName) {
      const parts = String(profile.childName || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length) {
        displayName = parts.shift();
        if (!family) family = parts.join(' ');
      }
    }

    return {
      phone: last10_(profile.phone || phoneKey),
      displayName: displayName,
      family: family
    };
  }).filter(function(entry) {
    return !!entry.displayName;
  });

  const children = buildReportChildren_(
    entries.map(function(entry) {
      return normalizeReportChildName_(entry.displayName, entry.family) || entry.displayName;
    }),
    entries.map(function(entry) { return entry.family; })
  );

  children.forEach(function(child, index) {
    const phone10 = entries[index] && entries[index].phone || '';
    child.phone = phone10 ? '8' + phone10 : '';
    child.phone10 = phone10;
    if (!child.suffixKey) child.identityKey = 'phone:' + (phone10 || child.index);
  });

  return children;
}

function uniqueReportChildrenByIdentity_(childrenRaw) {
  const byIdentity = {};
  (childrenRaw || []).filter(Boolean).forEach(function(child) {
    const key = reportChildIdentityKey_(child) || ('row:' + String(child.index));
    if (!byIdentity[key]) byIdentity[key] = child;
  });
  return Object.keys(byIdentity).map(function(key) { return byIdentity[key]; });
}

function formatRawReportNameToken_(valueRaw) {
  return String(valueRaw || '')
    .trim()
    .split(/(-)/)
    .map(function(part) {
      if (part === '-') return part;
      return part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part;
    })
    .join('');
}

function canonicalRawReportLabelForChild_(child, contextByBase, sourceNameRaw) {
  if (!child) return '';

  // For raw headings, use the first-column preferred form from NAME_VARIANTS.
  // If the educator's form is not in the dictionary, keep that form. The
  // parent-facing report continues to use the registered name from REPORTS.
  const sourceBase = stripInitialFromName_(sourceNameRaw || '') || String(sourceNameRaw || '').trim();
  const registeredBase = stripInitialFromName_(child.fullName || child.baseName) || child.baseName || child.fullName;
  const preferredBase = getPreferredNameVariant_(sourceBase || registeredBase);
  const baseName = formatRawReportNameToken_(preferredBase || sourceBase || registeredBase);
  if (!baseName) return '';

  const familyKey = normalizeFamilyName_(child.family || '');
  const suffixKey = String(child.suffixKey || '').trim();
  const ctx = contextByBase && contextByBase[child.baseKey] || { registered: [] };
  const siblings = uniqueReportChildrenByIdentity_(ctx.registered || []);

  let label = '';
  if (familyKey) {
    const initial = familyKey.charAt(0);
    const sameInitial = siblings.filter(function(candidate) {
      const family = normalizeFamilyName_(candidate && candidate.family || '');
      return family && family.charAt(0) === initial;
    });

    if (sameInitial.length <= 1) {
      label = baseName + ' ' + initial.toUpperCase() + '.';
    } else {
      for (let len = 2; len <= Math.min(4, familyKey.length); len += 1) {
        const prefix = familyKey.slice(0, len);
        const matching = uniqueReportChildrenByIdentity_(siblings.filter(function(candidate) {
          const family = normalizeFamilyName_(candidate && candidate.family || '');
          return family && family.indexOf(prefix) === 0;
        }));
        if (matching.length === 1 && reportChildIdentityKey_(matching[0]) === reportChildIdentityKey_(child)) {
          label = baseName + ' ' + formatRawReportNameToken_(prefix);
          break;
        }
      }

      if (!label) label = baseName + ' ' + formatRawReportNameToken_(child.family || familyKey);
    }
  } else if (suffixKey) {
    label = suffixKey.length === 1
      ? baseName + ' ' + suffixKey.toUpperCase() + '.'
      : baseName + ' ' + formatRawReportNameToken_(child.suffix || suffixKey);
  } else {
    return baseName;
  }

  // Changing Александр/Александра to neutral «Саша» is safe only when the
  // resulting heading still resolves to this same child. Keep the educator's
  // explicit form if the preferred spelling would make the block ambiguous.
  const parsed = getReportHeaderParts_(label);
  const resolution = resolveReportBlock_({
    rawName:parsed.raw,
    baseRaw:parsed.baseRaw,
    baseKey:parsed.baseKey,
    suffix:parsed.suffix,
    suffixKey:parsed.suffixKey,
    hasSuffix:parsed.hasSuffix
  }, contextByBase || {});
  const targets = reportResolutionTargets_(resolution);
  if (targets.length && targets.every(function(target) {
    return reportChildIdentityKey_(target) === reportChildIdentityKey_(child);
  })) return label;

  const fallbackBase = formatRawReportNameToken_(sourceBase || registeredBase);
  if (!fallbackBase) return '';
  if (familyKey) {
    const suffix = label.slice(baseName.length).trim();
    return fallbackBase + ' ' + suffix;
  }
  return fallbackBase;
}

function canonicalRawReportLabelForHeader_(header) {
  if (!header) return '';
  // An unregistered child has no authoritative display spelling, so preserve
  // the spelling that the educator actually wrote.
  const baseName = formatRawReportNameToken_(header.baseRaw);
  if (!baseName) return String(header.raw || '').trim();

  const suffixKey = String(header.suffixKey || '').trim();
  if (!suffixKey) return baseName;

  return suffixKey.length === 1
    ? baseName + ' ' + suffixKey.toUpperCase() + '.'
    : baseName + ' ' + formatRawReportNameToken_(header.suffix || suffixKey);
}

function classifyRawReportHeader_(header, knownBaseKeys, contextByBase) {
  if (!header || !header.baseKey) return { recognized:false, resolution:null };

  const isKnownRegistered = !!(knownBaseKeys && knownBaseKeys[header.baseKey]);
  const isKnownName = isInNameBase(normalizeName_(header.baseRaw));
  const probableAliasChildren = (!isKnownRegistered && !isKnownName)
    ? findProbableReportAliasChildren_(header, contextByBase)
    : [];
  const isProbableAlias = probableAliasChildren.length > 0;
  const isUnassignedHeader = (!isKnownRegistered && !isKnownName && !isProbableAlias)
    ? isPotentialUnassignedReportHeader_(header)
    : false;

  if (!isKnownRegistered && !isKnownName && !isProbableAlias && !isUnassignedHeader) {
    return { recognized:false, resolution:null };
  }

  const block = {
    rawName: header.raw,
    baseRaw: header.baseRaw,
    baseKey: header.baseKey,
    suffix: header.suffix,
    suffixKey: header.suffixKey,
    hasSuffix: header.hasSuffix,
    body: ''
  };

  const resolution = isProbableAlias
    ? makeUnknownReportAliasResolution_(probableAliasChildren)
    : (isUnassignedHeader ? makeUnassignedReportHeaderResolution_() : resolveReportBlock_(block, contextByBase));

  return {
    recognized:true,
    resolution:resolution,
    isUnassigned:isUnassignedHeader
  };
}

function reportResolutionTargets_(resolution) {
  if (!resolution) return [];
  return resolution.children && resolution.children.length
    ? resolution.children.filter(Boolean)
    : (resolution.child ? [resolution.child] : []);
}

function mapPreviousResolutionToCurrentChildren_(previousResolution, currentChildrenRaw) {
  const previousTargets = reportResolutionTargets_(previousResolution);
  const currentChildren = currentChildrenRaw || [];
  if (!previousTargets.length || !currentChildren.length) return [];

  const phones = {};
  previousTargets.forEach(function(child) {
    const phone = last10_(child && (child.phone10 || child.phone));
    if (phone) phones[phone] = true;
  });

  let matches = currentChildren.filter(function(child) {
    const phone = last10_(child && (child.phone10 || child.phone));
    return !!(phone && phones[phone]);
  });
  let unique = uniqueReportChildrenByIdentity_(matches);
  if (unique.length === 1) {
    const identity = reportChildIdentityKey_(unique[0]);
    return currentChildren.filter(function(child) {
      return reportChildIdentityKey_(child) === identity;
    });
  }

  const previousIdentities = {};
  previousTargets.forEach(function(child) {
    const identity = reportChildIdentityKey_(child);
    if (identity) previousIdentities[identity] = true;
  });
  matches = currentChildren.filter(function(child) {
    return !!previousIdentities[reportChildIdentityKey_(child)];
  });
  unique = uniqueReportChildrenByIdentity_(matches);
  if (unique.length !== 1) return [];

  const identity = reportChildIdentityKey_(unique[0]);
  return currentChildren.filter(function(child) {
    return reportChildIdentityKey_(child) === identity;
  });
}

function comparableReportBody_(valueRaw) {
  return normalizeReportBlockBody_(
    stripLeadingNameHeader_(String(valueRaw || ''))
  );
}

function rawReportBlockWasPreviouslyDistributed_(kindRaw, block, previousTargets, currentTargets) {
  const kind = String(kindRaw || '').toLowerCase();
  if (!['morning', 'evening'].includes(kind) || !block) return false;

  const expected = comparableReportBody_(block.body);
  if (!expected) return false;

  const phones = {};
  (previousTargets || []).concat(currentTargets || []).forEach(function(child) {
    const phone = last10_(child && (child.phone10 || child.phone));
    if (phone) phones[phone] = true;
  });
  if (!Object.keys(phones).length) return false;

  const sheet = getDataSheet_();
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (!sheet || lastRow < 2) return false;

  const rows = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const reportIndex = kind === 'morning' ? 4 : 5;

  return rows.some(function(row) {
    const phone = last10_(row[0]);
    if (!phone || !phones[phone] || !isActualReportText_(row[reportIndex])) return false;
    return comparableReportBody_(row[reportIndex]) === expected;
  });
}

function canonicalizeRawChildReport_(textRaw, optionsRaw) {
  const options = optionsRaw || {};
  const source = cleanIncomingText_(textRaw);
  const text = stripRoomNumbers_(source);
  if (!text) return { text:'', changed:false, rewritten:0, recovered:0, unresolved:[] };

  const currentChildren = options.children || buildReportValidationChildren_();
  const previousChildren = options.previousChildren || [];
  const currentKnown = buildKnownBaseKeys_(currentChildren);
  const previousKnown = buildKnownBaseKeys_(previousChildren);
  const currentContext = buildDistributionContext_(currentChildren, []);
  const previousContext = buildDistributionContext_(previousChildren, []);
  const confirmPreviousAssignment = typeof options.confirmPreviousAssignment === 'function'
    ? options.confirmPreviousAssignment
    : function() { return false; };

  const headerRe = /(^|\n)([ \t]*)([^:\-–—\n]+?)[ \t]*(?:\.?[ \t]*([:\-–—]))[ \t]*/g;
  const candidates = [];
  let match;

  while ((match = headerRe.exec(text)) !== null) {
    const header = getReportHeaderParts_(match[3].trim());
    const currentClass = classifyRawReportHeader_(header, currentKnown, currentContext);
    const previousClass = previousChildren.length
      ? classifyRawReportHeader_(header, previousKnown, previousContext)
      : { recognized:false, resolution:null };

    if (!currentClass.recognized && !previousClass.recognized) continue;

    candidates.push({
      start:match.index,
      end:headerRe.lastIndex,
      prefix:match[1] || '',
      indent:match[2] || '',
      header:header,
      currentClass:currentClass,
      previousClass:previousClass,
      bodyStart:headerRe.lastIndex
    });
  }

  const inferred = resolveReportBlocksByExclusion_(candidates.map(function(item) {
    return Object.assign({}, item.header, { forcedResolution:item.currentClass.resolution });
  }), currentContext);
  candidates.forEach(function(item, index) { item.currentClass.resolution = inferred[index]; });

  const replacements = [];
  const unresolved = [];
  let recovered = 0;

  candidates.forEach(function(item, index) {
    const bodyEnd = index + 1 < candidates.length ? candidates[index + 1].start : text.length;
    const block = {
      rawName:item.header.raw,
      baseRaw:item.header.baseRaw,
      baseKey:item.header.baseKey,
      suffix:item.header.suffix,
      suffixKey:item.header.suffixKey,
      hasSuffix:item.header.hasSuffix,
      body:normalizeReportBlockBody_(text.slice(item.bodyStart, bodyEnd))
    };

    let label = '';
    const currentResolution = item.currentClass && item.currentClass.resolution;

    if (currentResolution && currentResolution.status === 'ok') {
      const targets = reportResolutionTargets_(currentResolution);
      const previous = item.previousClass && item.previousClass.resolution;
      const previousTargets = previous && previous.status === 'ok' ? reportResolutionTargets_(previous) : [];
      if (previousTargets.length && !targets.some(function(target) {
        return previousTargets.some(function(old) {
          return reportChildIdentityKey_(target) === reportChildIdentityKey_(old) &&
            last10_(target.phone10 || target.phone) === last10_(old.phone10 || old.phone);
        });
      })) {
        unresolved.push(String(item.header.raw || '').trim());
        return;
      }
      label = canonicalRawReportLabelForChild_(targets[0], currentContext, item.header.baseRaw);
    } else if (
      currentResolution &&
      currentResolution.status === 'ambiguous' &&
      !block.hasSuffix &&
      item.previousClass &&
      item.previousClass.resolution &&
      item.previousClass.resolution.status === 'ok'
    ) {
      const previousTargets = reportResolutionTargets_(item.previousClass.resolution);
      const mappedTargets = mapPreviousResolutionToCurrentChildren_(
        item.previousClass.resolution,
        currentChildren
      );
      if (
        mappedTargets.length &&
        !candidates.some(function(other) {
          if (other === item || !other.header.hasSuffix) return false;
          const occupied = reportResolutionTargets_(other.currentClass.resolution);
          return occupied.some(function(child) {
            return mappedTargets.some(function(target) {
              return reportChildIdentityKey_(child) === reportChildIdentityKey_(target);
            });
          });
        }) &&
        confirmPreviousAssignment({
          block:block,
          previousTargets:previousTargets,
          currentTargets:mappedTargets
        })
      ) {
        label = canonicalRawReportLabelForChild_(mappedTargets[0], currentContext, item.header.baseRaw);
        recovered += 1;
      }
    } else if (
      currentResolution &&
      (currentResolution.status === 'no_parent' || item.currentClass.isUnassigned)
    ) {
      label = canonicalRawReportLabelForHeader_(item.header);
    }

    if (!label) {
      if (currentResolution && currentResolution.status === 'ambiguous') {
        unresolved.push(String(item.header.raw || '').trim());
      }
      return;
    }

    const replacement = item.prefix + item.indent + label + ' — ';
    const before = text.slice(item.start, item.end);
    if (before !== replacement) {
      replacements.push({ start:item.start, end:item.end, text:replacement });
    }
  });

  // A child block is one paragraph in the stored report. Flatten only the
  // body spans delimited by recognized headers; keep the newline that belongs
  // to the next child's header. Use the same body normalizer as the existing
  // ownership fingerprints so formatting cannot transfer reports to a child.
  candidates.forEach(function(item, index) {
    const end = index + 1 < candidates.length ? candidates[index + 1].start : text.length;
    const rawBody = text.slice(item.bodyStart, end);
    // A staff-only section is never part of a child's paragraph. Preserve
    // its separate heading when a caller invokes canonicalization directly;
    // normal web/manual report entry rejects it before distribution.
    const serviceMarker = /(?:^|\n)\s*[^\p{L}\p{N}\n]*(?:для[ \t]+врач(?:ей|а)|врачам|общ(?:ий|ие)[ \t]+комментар(?:ий|ии))(?=[^\p{L}]|$)/iu;
    if (serviceMarker.test(rawBody)) return;
    const flatBody = normalizeReportBlockBody_(rawBody);
    if (rawBody !== flatBody) {
      replacements.push({start:item.bodyStart, end:end, text:flatBody});
    }
  });

  let next = text;
  replacements.sort(function(a, b) { return b.start - a.start; }).forEach(function(replacement) {
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end);
  });

  // Everything before the first explicit child header is source-report boilerplate:
  // date, activities, authors, separators, etc.  Only a candidate that already
  // passed the same child-header classifier can become the cut point, so a bare
  // name mention without ':' or a dash can never trim the report accidentally.
  let preambleRemoved = false;
  if (candidates.length && candidates[0].start > 0) {
    next = next.slice(candidates[0].start).replace(/^\s+/, '');
    preambleRemoved = true;
  }

  next = normalizeReportSourcePunctuation_(next);

  return {
    text:next,
    changed:next !== source,
    rewritten:replacements.length,
    recovered:recovered,
    preambleRemoved:preambleRemoved,
    unresolved:uniqueStrings_(unresolved)
  };
}

function getLatestReportCell_(sheet, colIndex) {
  const col = Number(colIndex || 1);
  if (!sheet) return null;
  return sheet.getRange(1, col);
}

function setRawReportSourceNote_(cell, messageRaw) {
  if (!cell) return;
  const message = String(messageRaw || '').trim();
  if (message) cell.setNote(message);
  else cell.clearNote();
}

function rawReportValidationNote_(validation) {
  const names = validation && validation.ambiguousNames || [];
  return names.length ? 'Остальные блоки распределены. Неоднозначные блоки пропущены: «' + names.join('», «') + '». Уточните инициал или фамилию.' : '';
}

function prepareRawReportSourceText_(kindRaw, textRaw) {
  const kind = String(kindRaw || '').toLowerCase();
  // Web submissions and manual cell edits use the same structural rules.
  // Table-dependent NAME_VARIANTS resolution remains the additional stage.
  const basic = MedsiReportValidation.validate(kind, textRaw);
  if (!basic.ok) {
    return { ok:false, text:String(textRaw || ''), validation:basic, message:basic.message };
  }
  const canonical = canonicalizeRawChildReport_(textRaw);
  const validation = validateChildReportFormat_(kind, canonical.text);
  if (!validation.ok) {
    return {
      ok:false,
      text:canonical.text,
      canonical:canonical,
      validation:validation,
      message:validation.message
    };
  }
  return {
    ok:true,
    text:canonical.text,
    canonical:canonical,
    validation:validation
  };
}

function processRawReportSourceEdit_(kindRaw, sheet) {
  const kind = String(kindRaw || '').toLowerCase();
  if (!['morning', 'evening'].includes(kind) || !sheet) return { ok:false, message:'Неизвестный вид отчёта.' };

  const cell = getLatestReportCell_(sheet, 1);
  const raw = cell ? String(cell.getValue() || '') : '';
  const prepared = prepareRawReportSourceText_(kind, raw);

  if (!prepared.ok) {
    setRawReportSourceNote_(
      cell,
      'Автоматическое распределение остановлено: ' + String(prepared.message || 'проверьте заголовки детей.')
    );
    return prepared.validation;
  }

  if (!saveRawReportPublication_(kind, cell, prepared.text, Date.now(), raw)) {
    return {ok:true, skipped:true, message:'Источник отчёта уже обновлён.'};
  }
  distributeChildReports(kind);
  setRawReportSourceNote_(cell, rawReportValidationNote_(prepared.validation));
  return { ok:true, canonicalized:prepared.canonical.changed };
}

function redistributeChildReportKindMaintenanceCore_(kindRaw) {
  const kind = String(kindRaw || '').toLowerCase();
  if (!['morning', 'evening'].includes(kind)) return { ok:false, message:'Неизвестный вид отчёта.' };

  const dataSheet = getDataSheet_();
  const sourceSheet = getSheet_(kind === 'morning' ? SHEET_MORNING : SHEET_EVENING);
  if (!dataSheet || !sourceSheet) return { ok:false, message:'Не найден лист отчёта.' };

  const lastRow = dataSheet.getLastRow();
  const count = Math.max(lastRow - 1, 0);
  if (!count) return { ok:true, rows:0 };

  const rawNames = dataSheet.getRange(2, 3, count, 1).getValues().flat();
  const families = dataSheet.getRange(2, 4, count, 1).getValues().flat();
  const baseNames = normalizeReportChildNames_(
    dataSheet,
    rawNames.map(function(value) { return String(value || '').trim(); }),
    families
  );

  const children = attachPhonesToReportChildren_(
    buildReportChildren_(baseNames, families),
    dataSheet,
    count
  );
  const contextByBase = buildDistributionContext_(children, []);
  const rawText = getLatestReport(sourceSheet, 1) || '';
  const plan = computeReportKindPlan_(kind, rawText, children, contextByBase);
  if (!plan.ok) return plan;
  const previousRows = dataSheet.getRange(2, kind === 'morning' ? 5 : 6, count, 1).getValues();
  const ownershipPlan = planRawReportOwnershipGuard_(kind, plan.parsed, contextByBase,
    plan.distribution,
    previousRows.map(function(row) { return row[0]; }),
    false, loadRawReportOwnershipRecords_(kind, plan.parsed), Date.now());
  const MISSING = 'Пока ещё нет отчёта 🙏';
  const output = buildReportRowValues_(baseNames, ownershipPlan.distribution.byRow, MISSING);

  const targetColumn = kind === 'morning' ? 5 : 6;
  assertReportDistributionRosterUnchanged_(dataSheet, children, count);
  assertReportDistributionSourceUnchanged_(sourceSheet, rawText);
  commitRawReportOwnershipWrites_(ownershipPlan.proposedOwnershipWrites);
  assertReportDistributionRosterUnchanged_(dataSheet, children, count);
  assertReportDistributionSourceUnchanged_(sourceSheet, rawText);
  if (reportColumnValuesChanged_(previousRows, output)) dataSheet.getRange(2, targetColumn, count, 1).setValues(output);
  logRawReportOwnershipPlan_(kind, ownershipPlan);
  if (ownershipPlan.distribution.ownershipBlockedRows) setRawReportSourceNote_(sourceSheet.getRange(1, 1), 'Часть блоков не распределена: сохранённый владелец отчёта не совпадает с текущим ребёнком. Уточните полную фамилию и проверьте текст.');
  return { ok:true, rows:count, ownershipBlockedRows:Number(ownershipPlan.distribution.ownershipBlockedRows || 0) };
}

function maintainRawReportsAfterProfilesChangeCore_(previousSnapshotRaw, reasonRaw) {
  const previousChildren = buildReportChildrenFromProfileSnapshot_(previousSnapshotRaw || {});
  const currentChildren = buildReportValidationChildren_();
  const result = {
    ok:true,
    reason:String(reasonRaw || ''),
    rewritten:0,
    recovered:0,
    redistributed:0,
    blocked:0
  };

  ['morning', 'evening'].forEach(function(kind) {
    const sheet = getSheet_(kind === 'morning' ? SHEET_MORNING : SHEET_EVENING);
    const cell = getLatestReportCell_(sheet, 1);
    const raw = cell ? String(cell.getValue() || '') : '';
    if (!raw.trim()) return;

    const canonical = canonicalizeRawChildReport_(raw, {
      children:currentChildren,
      previousChildren:previousChildren,
      confirmPreviousAssignment:function(payload) {
        return rawReportBlockWasPreviouslyDistributed_(
          kind,
          payload.block,
          payload.previousTargets,
          payload.currentTargets
        );
      }
    });

    const validation = validateChildReportFormat_(kind, canonical.text);
    if (!validation.ok) {
      result.blocked += 1;
      setRawReportSourceNote_(
        cell,
        'Автоматическое перераспределение остановлено: ' + String(validation.message || 'проверьте заголовки детей.')
      );
      return;
    }

    if (cell && String(cell.getValue() || '') !== canonical.text) {
      cell.setValue(canonical.text);
      if (typeof syncReportHistorySourceFingerprintSilently_ === 'function') {
        syncReportHistorySourceFingerprintSilently_(kind, canonical.text);
      }
    }
    result.rewritten += Number(canonical.rewritten || 0);
    result.recovered += Number(canonical.recovered || 0);
    const distributed = redistributeChildReportKindMaintenanceCore_(kind);
    if (distributed && distributed.ok) {
      result.redistributed += 1;
      // Structural validation can pass while the ownership guard blocks a
      // previous admission. Preserve that guard's note instead of clearing it.
      if (distributed.ownershipBlockedRows) result.blocked += 1;
      else setRawReportSourceNote_(cell, rawReportValidationNote_(validation));
    }
  });

  if (result.redistributed) {
    try {
      syncD1CurrentReportsToWorker_('');
    } catch (error) {
      result.ok = false;
      Logger.log('REPORT_MAINTENANCE_D1_SYNC_FAILED ' + String(error && error.message || error));
    }
  }

  return result;
}


function prepareReportForParent_(text, storedName, cleanName) {
  if (!text || text === 'Пока ещё нет отчёта 🙏') return text;

  const from = escapeRegExp_(storedName);
  const re = new RegExp(`(^|\\n\\n?)${from}\\.?\\s*[:\\-–—]\\s*`, 'gu');
  return String(text).replace(re, `$1${cleanName}: `);
}

function stripInitialFromName_(name) {
  return String(name || '')
    .trim()
    .replace(/\s+[A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]{0,31}\.?$/, '')
    .trim();
}

function getSuffixToken_(fullName) {
  const m = String(fullName || '')
    .trim()
    .match(/\s+([A-ZА-ЯЁ][A-Za-zА-Яа-яЁё-]{0,31})\.?$/);
  return m ? m[1] : '';
}

/*
 * Raw MORNING/EVENING reports are the only place where a child can still be
 * mentioned after their REPORTS row is removed.  Their headers use the short
 * form (for example, "Кирилл Ш."), while REPORTS also keeps the full family
 * name.  Keep the two pieces of identity together so a cleanup never removes
 * another child with the same first name.
 */
function rawReportChildTargetFromReportRow_(row) {
  const displayName = normalizeReportChildName_(row && row[2], row && row[3]);
  const header = getReportHeaderParts_(displayName);
  const familyKey = normalizeFamilyName_(row && row[3]);
  const suffixKey = header.suffixKey || getFamilyInitialSuffix_(row && row[3]).toLowerCase();

  if (!header.baseKey || !suffixKey) return null;
  return {
    baseKey: header.baseKey,
    suffixKey: suffixKey,
    familyKey: familyKey,
    displayName: displayName,
    identityKey: [header.baseKey, suffixKey, familyKey].join('|')
  };
}

function rawReportChildTargetFromProfileSnapshot_(profile) {
  if (!profile) return null;
  const storedName = String(profile.reportChildName || '').trim();
  const storedFamily = String(profile.familyName || '').trim();

  if (storedName) {
    return rawReportChildTargetFromReportRow_(['', '', storedName, storedFamily]);
  }

  // Snapshots made before this cleanup was introduced only contain the public
  // form "Имя Фамилия".  It is enough for a conservative one-time fallback:
  // take the first word as the first name and use the remaining words solely
  // to derive the family initial.  If either part is absent, leave the raw
  // report untouched rather than guessing.
  const legacyParts = String(profile.childName || '').trim().split(/\s+/).filter(Boolean);
  if (legacyParts.length < 2) return null;
  return rawReportChildTargetFromReportRow_([
    '', '', legacyParts.shift(), legacyParts.join(' ')
  ]);
}

function rawReportHeaderMatchesTarget_(header, target) {
  if (!header || !target || header.baseKey !== target.baseKey || !header.hasSuffix) return false;
  const suffixKey = String(header.suffixKey || '');
  if (!suffixKey) return false;
  if (suffixKey === target.suffixKey) return true;

  // A longer beginning of the surname is allowed by the report parser for
  // cases such as two children with the same first-name initial.
  return suffixKey.length >= 2 && !!target.familyKey && target.familyKey.indexOf(suffixKey) === 0;
}

function rawReportHeaderIdentifiesOnlyTarget_(header, target, allTargets) {
  if (!rawReportHeaderMatchesTarget_(header, target)) return false;
  const candidatesByIdentity = {};
  (allTargets || []).forEach(function(candidate) {
    if (rawReportHeaderMatchesTarget_(header, candidate)) {
      candidatesByIdentity[candidate.identityKey] = candidate;
    }
  });
  const candidates = Object.keys(candidatesByIdentity).map(function(key) { return candidatesByIdentity[key]; });

  // A lone "Кирилл Ш." is deliberately kept if there are two different
  // Kirills with that same initial.  A longer surname prefix is safe once it
  // narrows the header down to this exact child.
  return candidates.length === 1 && candidates[0].identityKey === target.identityKey;
}

function rawReportTargetsNoLongerActive_(targetsRaw, activeTargetsRaw) {
  const active = {};
  (activeTargetsRaw || []).filter(Boolean).forEach(function(target) {
    active[target.identityKey] = true;
  });
  const unique = {};
  (targetsRaw || []).filter(Boolean).forEach(function(target) {
    if (!active[target.identityKey]) unique[target.identityKey] = target;
  });
  return Object.keys(unique).map(function(key) { return unique[key]; });
}

function removeRawReportBlocksForChildren_(textRaw, targets, allTargets) {
  const text = String(textRaw || '');
  if (!text || !targets || !targets.length) return { text: text, removedBlocks: 0 };

  const headerRe = /(^|\n)\s*([^:\-–—\n]+?)\s*(?:\.?\s*[:\-–—])\s*/g;
  const headers = [];
  let match;
  while ((match = headerRe.exec(text)) !== null) {
    headers.push({
      start: match.index,
      end: headerRe.lastIndex,
      header: getReportHeaderParts_(match[2].trim())
    });
  }

  const ranges = [];
  headers.forEach(function(item, index) {
    const shouldRemove = targets.some(function(target) {
      return rawReportHeaderIdentifiesOnlyTarget_(item.header, target, allTargets);
    });
    if (!shouldRemove) return;
    ranges.push({ start: item.start, end: index + 1 < headers.length ? headers[index + 1].start : text.length });
  });

  if (!ranges.length) return { text: text, removedBlocks: 0 };

  let next = text;
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    next = next.slice(0, ranges[i].start) + next.slice(ranges[i].end);
  }
  next = next.replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: next, removedBlocks: ranges.length };
}

function prepareRawReportCleanupForChildren_(targetsRaw, allTargetsRaw) {
  const targets = (targetsRaw || []).filter(Boolean);
  const allTargets = (allTargetsRaw || []).filter(Boolean);
  if (!targets.length) return { patches: [], removedBlocks: 0 };

  const patches = [];
  let removedBlocks = 0;
  [SHEET_MORNING, SHEET_EVENING].forEach(function(sheetName) {
    const sheet = getSheet_(sheetName);
    const lastRow = sheet ? sheet.getLastRow() : 0;
    if (!sheet || lastRow < 1) return;
    const values = sheet.getRange(1, 1, lastRow, 1).getValues();
    values.forEach(function(row, index) {
      const result = removeRawReportBlocksForChildren_(row[0], targets, allTargets);
      if (!result.removedBlocks) return;
      patches.push({ sheet: sheet, row: index + 1, before: String(row[0] || ''), after: result.text });
      removedBlocks += result.removedBlocks;
    });
  });
  return { patches: patches, removedBlocks: removedBlocks };
}

function applyRawReportCleanup_(plan) {
  const touchedSheets = {};
  (plan && plan.patches || []).forEach(function(patch) {
    // Never overwrite a report that was edited after the deletion started.
    // The next REPORTS change will create a fresh cleanup plan instead.
    const range = patch.sheet.getRange(patch.row, 1);
    if (String(range.getValue() || '') !== patch.before) {
      throw new Error('Сырой отчёт был изменён во время удаления; повторите удаление.');
    }
    range.setValue(patch.after);
    touchedSheets[patch.sheet.getName()] = patch.sheet;
  });
  Object.keys(touchedSheets).forEach(function(sheetName) {
    const kind = sheetName === SHEET_MORNING ? 'morning' : (sheetName === SHEET_EVENING ? 'evening' : '');
    if (kind && typeof syncReportHistorySourceFingerprintSilently_ === 'function') {
      syncReportHistorySourceFingerprintSilently_(kind, getLatestReport(touchedSheets[sheetName], 1) || '');
    }
  });
  return { removedBlocks: Number(plan && plan.removedBlocks || 0) };
}

function distributeChildReports(triggerKindRaw) {
  // A surviving old minute timer upgrades itself without running a full pass.
  if (triggerKindRaw && typeof triggerKindRaw === 'object' && triggerKindRaw.triggerUid && typeof ensureReportMaintenanceClock_ === 'function') {
    ensureReportMaintenanceClock_();
    return runScheduledMedsiMaintenance(triggerKindRaw);
  }
  let postCommitSync = null;
  const result = withReportWriteLock_(function() {
  removeLegacyDistributionLogSheet_();

  const dataSheet    = getDataSheet_();
  const morningSheet = getSheet_(SHEET_MORNING);
  const eveningSheet = getSheet_(SHEET_EVENING);
  if (!dataSheet || !morningSheet || !eveningSheet) return;

  const morningText = getLatestReport(morningSheet, 1) || "";
  const eveningText = getLatestReport(eveningSheet, 1) || "";
  const triggerKind = String(triggerKindRaw || '').toLowerCase();
  const scheduledSignature = typeof reportDistributionStateFingerprint_ === 'function' ? reportDistributionStateFingerprint_() : '';
  const checkpointProperties = PropertiesService.getScriptProperties();
  if (!['morning', 'evening'].includes(triggerKind) && scheduledSignature &&
      checkpointProperties.getProperty('REPORT_DISTRIBUTION_CHECKPOINT') === scheduledSignature) {
    return {ok:true, skipped:true, reason:'unchanged'};
  }

  const lastRow = dataSheet.getLastRow();
  const count   = Math.max(lastRow - 1, 0);
  if (count === 0) {
    syncReportHistoryPublicationFromSource_('morning', morningText, triggerKind === 'morning');
    syncReportHistoryPublicationFromSource_('evening', eveningText, triggerKind === 'evening');
    return;
  }

  const rawNames = dataSheet.getRange(2, 3, count, 1).getValues().flat();
  const families = dataSheet.getRange(2, 4, count, 1).getValues().flat();

  const baseNames = normalizeReportChildNames_(
    dataSheet,
    rawNames.map(n => String(n || '').trim()),
    families
  );

  const previousReports = dataSheet.getRange(2, 5, count, 2).getValues();
  const reportPhones = dataSheet.getRange(2, 1, count, 1).getValues().flat();
  const children = attachPhonesToReportChildren_(
    buildReportChildren_(baseNames, families),
    dataSheet,
    count
  );
  const contextByBase = buildDistributionContext_(children, []);
  const morningPlan = computeReportKindPlan_('morning', morningText, children, contextByBase);
  const eveningPlan = computeReportKindPlan_('evening', eveningText, children, contextByBase);
  if (!morningPlan.ok || !eveningPlan.ok) return;

  const morningOwnershipPlan = planRawReportOwnershipGuard_('morning', morningPlan.parsed, contextByBase,
    morningPlan.distribution, previousReports.map(function(row) { return row[0]; }), false,
    loadRawReportOwnershipRecords_('morning', morningPlan.parsed), Date.now());
  const eveningOwnershipPlan = planRawReportOwnershipGuard_('evening', eveningPlan.parsed, contextByBase,
    eveningPlan.distribution, previousReports.map(function(row) { return row[1]; }), false,
    loadRawReportOwnershipRecords_('evening', eveningPlan.parsed), Date.now());

  const MISSING = "Пока ещё нет отчёта 🙏";
  const morningOut = buildReportRowValues_(baseNames, morningOwnershipPlan.distribution.byRow, MISSING);
  const eveningOut = buildReportRowValues_(baseNames, eveningOwnershipPlan.distribution.byRow, MISSING);
  const inactivityUpdates = [];

  for (let i = 0; i < count; i++) {
    const m = morningOut[i][0];
    const e = eveningOut[i][0];
    inactivityUpdates.push({
      phone: reportPhones[i],
      hasNewReport: (m !== MISSING && String(m) !== String(previousReports[i][0] || '')) ||
        (e !== MISSING && String(e) !== String(previousReports[i][1] || ''))
    });

  }

  assertReportDistributionRosterUnchanged_(dataSheet, children, count);
  assertReportDistributionSourceUnchanged_(morningSheet, morningText);
  assertReportDistributionSourceUnchanged_(eveningSheet, eveningText);
  commitRawReportOwnershipWrites_(morningOwnershipPlan.proposedOwnershipWrites);
  commitRawReportOwnershipWrites_(eveningOwnershipPlan.proposedOwnershipWrites);
  assertReportDistributionRosterUnchanged_(dataSheet, children, count);
  assertReportDistributionSourceUnchanged_(morningSheet, morningText);
  assertReportDistributionSourceUnchanged_(eveningSheet, eveningText);
  if (reportColumnValuesChanged_(previousReports.map(function(row) { return [row[0]]; }), morningOut)) dataSheet.getRange(2, 5, count, 1).setValues(morningOut);
  assertReportDistributionRosterUnchanged_(dataSheet, children, count);
  assertReportDistributionSourceUnchanged_(morningSheet, morningText);
  assertReportDistributionSourceUnchanged_(eveningSheet, eveningText);
  if (reportColumnValuesChanged_(previousReports.map(function(row) { return [row[1]]; }), eveningOut)) dataSheet.getRange(2, 6, count, 1).setValues(eveningOut);
  syncReportHistoryPublicationFromSource_('morning', morningText, triggerKind === 'morning');
  syncReportHistoryPublicationFromSource_('evening', eveningText, triggerKind === 'evening');
  logRawReportOwnershipPlan_('morning', morningOwnershipPlan);
  logRawReportOwnershipPlan_('evening', eveningOwnershipPlan);
  if (morningOwnershipPlan.distribution.ownershipBlockedRows) setRawReportSourceNote_(morningSheet.getRange(1, 1), 'Часть блоков не распределена: сохранённый владелец отчёта не совпадает с текущим ребёнком. Уточните полную фамилию и проверьте текст.');
  if (eveningOwnershipPlan.distribution.ownershipBlockedRows) setRawReportSourceNote_(eveningSheet.getRange(1, 1), 'Часть блоков не распределена: сохранённый владелец отчёта не совпадает с текущим ребёнком. Уточните полную фамилию и проверьте текст.');
  // Один пакетный снимок после распределения. Повторные запуски с тем же
  // содержимым не меняют версию и не создают ложных уведомлений.
  const reportDate = reportHistoryDate_(new Date());
  const changedPublications = [];
  ['morning', 'evening'].forEach(function(kind) {
    if (triggerKind === kind || reportHistoryPublicationMatches_(kind, reportDate)) changedPublications.push(kind);
  });
  postCommitSync = {
    inactivityUpdates: inactivityUpdates,
    changedPublications: changedPublications
  };
  if (typeof queueReportPostCommitSync_ === 'function') {
    queueReportPostCommitSync_(inactivityUpdates, changedPublications, undefined, true);
    const committedSignature = reportDistributionStateFingerprint_();
    assertReportDistributionRosterUnchanged_(dataSheet, children, count);
    assertReportDistributionSourceUnchanged_(morningSheet, morningText);
    assertReportDistributionSourceUnchanged_(eveningSheet, eveningText);
    checkpointProperties.setProperty('REPORT_DISTRIBUTION_CHECKPOINT', committedSignature);
  }
  return {ok:true, changed:true};
  });
  // Сетевые вызовы выполняются после освобождения блокировки записи в отчёты.
  // Если синхронизация задержится, D1 принимает публикации только по версии.
  if (typeof flushPendingReportPostCommitSync_ === 'function') {
    flushPendingReportPostCommitSync_();
    return result;
  }
  if (postCommitSync) {
    try { syncReportInactivityState_(postCommitSync.inactivityUpdates); }
    catch (error) { Logger.log('REPORT_INACTIVITY_SYNC_AFTER_DISTRIBUTION_FAILED ' + (error && error.message || error)); }
    try {
      if (postCommitSync.changedPublications.length > 1) {
        postCommitSync.changedPublications.forEach(function(kind) { syncD1CurrentReportsToWorker_('', kind); });
      } else {
        syncD1CurrentReportsToWorker_('', postCommitSync.changedPublications[0] || '');
      }
    } catch (error) {
      Logger.log('REPORT_CURRENT_SYNC_AFTER_DISTRIBUTION_FAILED ' + (error && error.message || error));
    }
  }
  return result;
}

function withReportWriteLock_(callback) {
  const lock = LockService.getUserLock();
  lock.waitLock(15000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function pluralizeDaysRu_(n) {
  const value = Math.abs(Number(n) || 0);
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return 'дня';
  return 'дней';
}

function humanTime_(ts){
  if(!ts) return '';

  const date = new Date(ts);
  const now = new Date();

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffDays = Math.round((today - msgDay) / (24 * 60 * 60 * 1000));

  const time = Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'HH:mm'
  );

  if(diffDays === 0) return 'сегодня • ' + time;
  if(diffDays === 1) return 'вчера • ' + time;

  const months = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  const dateLabel = date.getDate() + ' ' + months[date.getMonth()];

  return dateLabel + ' • ' + time;
}

/**
 * Запуск этой функции нужен, чтобы Google запросил разрешение на доступ к Drive
 * для папки с фотографиями
 */
function testDriveAccess() {
  try {
    // Проверяем папку с фото
    const photoFolder = getChatPhotosFolder_();
    Logger.log('✅ Папка фото: ' + photoFolder.getName());

    return 'Папка фотографий успешно создана/найдена:\n' +
           '• ' + photoFolder.getName();
  } catch (e) {
    Logger.log('❌ Ошибка: ' + e);
    return 'Ошибка: ' + e.toString();
  }
}

function testUrlFetchAuthorization() {
  const result = sendPushDebugEvent_({
    role: 'appscript-auth-test',
    phone: '',
    title: 'Apps Script auth test',
    body: 'Testing UrlFetchApp authorization'
  });

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function testFetchDirect() {
  const res = UrlFetchApp.fetch('https://www.google.com');
  Logger.log(res.getResponseCode());
}

// Compatibility for already installed/queued historical triggers. Never access Sheets or Drive.
function cleanupInactiveChatMessages() { return retiredLegacyChatApi_(); }
function cleanupExpiredChatImages() { return retiredLegacyChatApi_(); }
