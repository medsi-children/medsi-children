'use strict';

// Timeweb Node.js App Platform starts server.js via PM2 by default, even
// when package.json defines npm start. A NEXT stand must never accidentally
// launch the legacy Apps Script/Cloudflare gateway or touch patient data.
// Only this feature branch contains the boot switch; production is unchanged.
if (process.env.MEDSI_NEXT_STAND === '1') {
  import('./services/ydb-next/src/stand-entry.mjs').catch(() => {
    // No secret, source data, or connection details in deployment logs.
    console.error('MEDSI_NEXT_STAND_START_FAILED: isolated runtime unavailable.');
    process.exitCode = 1;
  });
} else {
require('./lib/session-preload');
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const database = require('./lib/database');
const storage = require('./lib/s3-storage');
const mediaPreviews = require('./lib/media-previews');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(__dirname);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const CHAT_UPSTREAM = String(
  process.env.CHAT_UPSTREAM || 'https://medsi-chat-worker.medsi-children.workers.dev'
).replace(/\/$/, '');
const APP_SCRIPT_URL = String(process.env.APP_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbzRKRjjI7NoHx8rD5ifEdrcexGuYlMEB453sOC2UTZDeBaybZiNPIY0vDTMkmeHhebVpA/exec').trim();
const UPLOAD_UPSTREAM = String(
  process.env.UPLOAD_UPSTREAM || 'https://medsi-chat-upload-test.medsi-children.workers.dev'
).replace(/\/$/, '');
const PUSH_UPSTREAM = String(
  process.env.PUSH_UPSTREAM || 'https://medsi-push-worker.medsi-children.workers.dev'
).replace(/\/$/, '');
const MIGRATION_SHARED_SECRET = String(process.env.MIGRATION_SHARED_SECRET || '');
// Kept separate from the short-lived legacy-media migration credential.  This
// secret authorizes only Apps Script's durable deletion queue.
const REPORTS_SYNC_SECRET = String(process.env.REPORTS_SYNC_SECRET || '');

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function migrationAuthorized(req) {
  return Boolean(MIGRATION_SHARED_SECRET) && timingSafeEqual(
    req.get('X-Medsi-Migration-Secret'),
    MIGRATION_SHARED_SECRET
  );
}

function reportsSyncAuthorized(req) {
  return Boolean(REPORTS_SYNC_SECRET) && timingSafeEqual(
    req.get('X-Medsi-Reports-Sync-Secret'),
    REPORTS_SYNC_SECRET
  );
}

function forwardedHeaders(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers || {})) {
    if (value == null) continue;
    const lower = name.toLowerCase();
    if (['host', 'connection', 'content-length', 'accept-encoding'].includes(lower)) continue;
    if (Array.isArray(value)) value.forEach(v => headers.append(name, String(v)));
    else headers.set(name, String(value));
  }
  return headers;
}

async function proxy(req, res, target) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    const options = {
      method,
      headers: forwardedHeaders(req),
      redirect: 'manual',
      signal: method === 'GET' && target.startsWith(CHAT_UPSTREAM + '/lab/')
        ? AbortSignal.timeout(20000) : undefined
    };

    if (!['GET', 'HEAD'].includes(method)) {
      options.body = req;
      options.duplex = 'half';
    }

    const upstream = await fetch(target, options);
    res.status(upstream.status);

    for (const name of [
      'content-type',
      'content-disposition',
      'cache-control',
      'etag',
      'last-modified',
      'x-content-type-options',
      'accept-ranges',
      'content-range',
      'content-length',
      'location'
    ]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }

    if (!upstream.body || method === 'HEAD') {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise(resolve => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (error) {
    console.error('UPSTREAM_PROXY_FAILED', target, error);
    if (!res.headersSent) {
      res.status(502).json({ ok: false, code: 'UPSTREAM_UNAVAILABLE', message: 'Временная ошибка связи с сервером чата.' });
    } else {
      res.end();
    }
  }
}

async function probe(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    });
    try { await response.body?.cancel(); } catch (_) {}
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error.message
    };
  }
}

async function probeAppsScript() {
  const startedAt = Date.now();
  try {
    // A deliberately invalid token exercises the live web app without reading
    // records, creating a session, or exposing a real employee credential.
    const response = await fetch(APP_SCRIPT_URL, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ action: 'api', method: 'verifyTutorSession', args: ['health-check'] }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    const payload = await response.json();
    return {
      ok: response.ok && payload && payload.ok === true && payload.result && payload.result.ok === false,
      status: response.status,
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, message: error.message };
  }
}

function sessionToken(req) {
  return String(req.get('X-Medsi-Chat-Session') || '').trim();
}

async function validateSessionForPhone(req, phone) {
  const token = sessionToken(req);
  if (!token || !phone) return { ok: false, status: 401, transient: false };
  try {
    const response = await fetch(
      CHAT_UPSTREAM + '/lab/threads/' + encodeURIComponent(String(phone)) + '?before=&limit=1',
      {
        method: 'GET',
        headers: { 'X-Medsi-Chat-Session': token },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000)
      }
    );
    const status = response.status;
    try { await response.body?.cancel(); } catch (_) {}
    return {
      ok: response.ok,
      status,
      transient: status === 408 || status === 425 || status === 429 || status >= 500
    };
  } catch (error) {
    return { ok: false, status: 503, transient: true, message: error && error.message };
  }
}

// Stop old open tabs from sending assistant conversations to storage.
app.all(['/lab/bot-log', '/__bot-log-view'], (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.status(410).json({ ok: false });
});

app.all(/^\/lab(?:\/.*)?$/, (req, res) => {
  proxy(req, res, CHAT_UPSTREAM + req.originalUrl);
});

app.all(/^\/push(?:\/.*)?$/, (req, res) => {
  const suffix = req.originalUrl.replace(/^\/push/, '') || '/';
  proxy(req, res, PUSH_UPSTREAM + suffix);
});

app.get('/media/s3/:key', async (req, res) => {
  if (!storage.configured) {
    res.status(503).json({ ok: false, code: 'S3_NOT_CONFIGURED', message: 'Хранилище медиа ещё не подключено.' });
    return;
  }
  try {
    const wantsPreview = String(req.query.variant || '') === 'preview';
    const previewKey = wantsPreview ? await mediaPreviews.ensure(req.params.key) : null;
    const object = await storage.getObject(previewKey || req.params.key, previewKey ? undefined : req.headers.range);
    if (object.ContentType) res.setHeader('content-type', object.ContentType);
    if (object.ContentDisposition) res.setHeader('content-disposition', object.ContentDisposition);
    if (object.ContentLength != null) res.setHeader('content-length', String(object.ContentLength));
    if (object.ContentRange) res.setHeader('content-range', object.ContentRange);
    res.setHeader('accept-ranges', object.AcceptRanges || 'bytes');
    res.setHeader('cache-control', 'private, max-age=3600');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(object.ContentRange ? 206 : 200);
    if (object.Body && typeof object.Body.pipe === 'function') {
      object.Body.pipe(res);
    } else {
      const bytes = await object.Body.transformToByteArray();
      res.end(Buffer.from(bytes));
    }
  } catch (error) {
    const status = error && (error.$metadata?.httpStatusCode || error.statusCode);
    if (status === 404 || error?.name === 'NoSuchKey') {
      res.status(404).end();
      return;
    }
    console.error('S3_MEDIA_READ_FAILED', error);
    res.status(502).json({ ok: false, code: 'MEDIA_READ_FAILED', message: 'Не удалось загрузить вложение.' });
  }
});

app.all(/^\/media(?:\/.*)?$/, (req, res) => {
  proxy(req, res, CHAT_UPSTREAM + req.originalUrl);
});

app.post('/chat-upload', async (req, res) => {
  if (!storage.configured) {
    proxy(req, res, UPLOAD_UPSTREAM + '/chat-upload');
    return;
  }

  const phone = String(req.get('X-Medsi-Phone') || '').replace(/\D+/g, '').slice(-10);
  const length = Number(req.headers['content-length'] || 0);
  const rawUploadId = String(req.get('X-Medsi-Upload-Id') || '').trim();
  const uploadId = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(rawUploadId) ? rawUploadId : '';
  if (rawUploadId && !uploadId) {
    res.status(400).json({ ok: false, code: 'INVALID_UPLOAD_ID', message: 'Некорректный идентификатор загрузки.' });
    return;
  }
  if (length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', message: 'Размер файла не должен превышать 100 МБ.' });
    return;
  }

  const validation = await validateSessionForPhone(req, phone);
  if (!validation.ok) {
    if (validation.transient) {
      res.status(503).json({ ok: false, code: 'SESSION_CHECK_UNAVAILABLE', message: 'Сервер временно не смог проверить сессию. Повторяем загрузку.' });
      return;
    }
    res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Сессия чата истекла. Откройте чат заново.' });
    return;
  }

  try {
    const uploaded = await storage.uploadStream({
      body: req,
      contentType: req.get('content-type') || '',
      contentLength: length,
      fileName: req.get('X-File-Name') || 'attachment',
      uploadId
    });
    res.setHeader('cache-control', 'no-store');
    res.json({
      ok: true,
      type: uploaded.mediaType,
      fileId: 's3:' + uploaded.key,
      url: '/media/s3/' + encodeURIComponent(uploaded.key)
    });
    if (uploaded.mediaType === 'image') void mediaPreviews.ensure(uploaded.key);
  } catch (error) {
    console.error('S3_UPLOAD_FAILED', error);
    const unsupported = error && error.code === 'UNSUPPORTED_MEDIA';
    res.status(unsupported ? 415 : 502).json({
      ok: false,
      code: unsupported ? 'UNSUPPORTED_MEDIA' : 'UPLOAD_FAILED',
      message: unsupported ? error.message : 'Не удалось загрузить вложение.'
    });
  }
});

// This endpoint is intentionally separate from normal chat uploads. It is for
// the one-off legacy-media migration only: Apps Script sends a source file
// after reading it from Drive/KV, then updates D1 itself only after the hash
// returned below matches the source hash. It is inert until a Timeweb secret
// is configured and cannot be authenticated by a browser chat session.
app.post('/__migration/media', async (req, res) => {
  if (!migrationAuthorized(req)) {
    res.status(404).end();
    return;
  }
  if (!storage.configured) {
    res.status(503).json({ ok: false, code: 'S3_NOT_CONFIGURED' });
    return;
  }

  const expectedSha256 = String(req.get('X-Medsi-Source-Sha256') || '')
    .trim()
    .toLowerCase();
  const length = Number(req.headers['content-length'] || 0);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    res.status(400).json({ ok: false, code: 'SOURCE_HASH_REQUIRED' });
    return;
  }
  if (length <= 0 || length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE' });
    return;
  }

  let uploaded;
  try {
    uploaded = await storage.uploadStream({
      body: req,
      contentType: req.get('content-type') || '',
      contentLength: length,
      fileName: req.get('X-File-Name') || 'legacy-attachment'
    });
    const sha256 = await storage.sha256Object(uploaded.key);
    if (!timingSafeEqual(sha256, expectedSha256)) {
      await storage.removeObject(uploaded.key);
      res.status(422).json({ ok: false, code: 'SOURCE_HASH_MISMATCH' });
      return;
    }
    if (uploaded.mediaType === 'image') await mediaPreviews.ensure(uploaded.key);
    res.setHeader('cache-control', 'no-store');
    res.json({
      ok: true,
      fileId: 's3:' + uploaded.key,
      type: uploaded.mediaType,
      sha256
    });
  } catch (error) {
    if (uploaded && uploaded.key) {
      try { await storage.removeObject(uploaded.key); } catch (_) {}
    }
    console.error('LEGACY_MEDIA_MIGRATION_UPLOAD_FAILED', error);
    res.status(502).json({ ok: false, code: 'MIGRATION_UPLOAD_FAILED' });
  }
});

// Apps Script places an attachment list into its retryable deletion queue
// before removing the D1 thread.  This endpoint is deliberately not part of
// the browser session or the normal upload API.
app.post('/__sync/purge-s3', express.json({ limit: '128kb' }), async (req, res) => {
  if (!reportsSyncAuthorized(req)) {
    res.status(404).end();
    return;
  }
  if (!storage.configured) {
    res.status(503).json({ ok: false, code: 'S3_NOT_CONFIGURED' });
    return;
  }

  const keys = [...new Set(Array.isArray(req.body && req.body.keys) ? req.body.keys : [])]
    .map(value => String(value || '').trim())
    .filter(value => value && value.length <= 1024)
    .slice(0, 500);
  if (!keys.length) {
    res.json({ ok: true, deleted: [], failed: [] });
    return;
  }

  const result = await Promise.allSettled(keys.map(key => storage.removeObject(key)));
  const deleted = [];
  const failed = [];
  result.forEach((entry, index) => {
    if (entry.status === 'fulfilled') deleted.push(keys[index]);
    else failed.push({ key: keys[index], message: String(entry.reason && entry.reason.message || 'S3_DELETE_FAILED') });
  });
  res.setHeader('cache-control', 'no-store');
  res.status(failed.length ? 502 : 200).json({ ok: failed.length === 0, deleted, failed });
});

app.get('/__health', async (_req, res) => {
  const [db, media] = await Promise.all([database.health(), storage.health()]);
  const ok = db.ok && media.ok;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'medsi-timeweb-gateway',
    database: db,
    media
  });
});

app.get('/__diag/network', async (_req, res) => {
  const [chat, upload, push, appsScript, db, media] = await Promise.all([
    probe(CHAT_UPSTREAM + '/'),
    probe(UPLOAD_UPSTREAM + '/'),
    probe(PUSH_UPSTREAM + '/'),
    probeAppsScript(),
    database.health(),
    storage.health()
  ]);

  res.setHeader('cache-control', 'no-store');
  const ok = chat.ok && upload.ok && push.ok && appsScript.ok && db.ok && media.ok;
  res.status(ok ? 200 : 502).json({
    ok,
    measuredAt: new Date().toISOString(),
    timewebToCloudflare: { chat, upload, push },
    timewebToAppsScript: appsScript,
    database: db,
    media
  });
});

function sendAppFile(res, fileName) {
  res.setHeader('cache-control', 'no-store');
  res.sendFile(path.join(ROOT, fileName));
}

// Clean production URLs. Keep the .html files themselves available for old bookmarks.
app.get(['/', '/index.html'], (_req, res) => sendAppFile(res, 'index.html'));
app.get(['/tutors', '/tutors/'], (_req, res) => sendAppFile(res, 'tutors.html'));
app.get(['/psychology', '/psychology/'], (_req, res) => sendAppFile(res, 'psychology.html'));
app.get(['/tutors.html', '/psychology.html'], (req, res) => {
  sendAppFile(res, req.path === '/tutors.html' ? 'tutors.html' : 'psychology.html');
});

// Never expose the whole repository.  The source tree contains operational
// notes, backups and server code that the browser does not need.  Assets are
// explicitly allowlisted instead of using express.static(ROOT).
const publicStaticOptions = {
  dotfiles: 'ignore',
  index: false,
  maxAge: 0,
  etag: true
};
const publicStatic = express.static(ROOT, publicStaticOptions);

// A mounted static middleware receives a path without its mount prefix, so
// each directory needs its own root.  Keeping this explicit prevents assets
// such as bottom-lock.js from disappearing while still hiding the repository.
app.use('/parents', express.static(path.join(ROOT, 'parents'), publicStaticOptions));
app.use('/chat-overlay', express.static(path.join(ROOT, 'chat-overlay'), publicStaticOptions));
app.use('/tutors', express.static(path.join(ROOT, 'tutors'), publicStaticOptions));
app.use('/psychology', express.static(path.join(ROOT, 'psychology'), publicStaticOptions));
app.get([
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon2.png',
  '/manifest.json',
  '/tutors-manifest.json',
  '/notify-client.js',
  '/sw.js'
], publicStatic);

app.use((_req, res) => res.status(404).end());

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Medsi Timeweb gateway listening on ${PORT}`);
});
}
