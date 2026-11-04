'use strict';

const crypto = require('crypto');
const {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const bucket = String(process.env.S3_BUCKET || '').trim();
const endpoint = String(process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru').replace(/\/$/, '');
const region = String(process.env.S3_REGION || 'ru-1');
const accessKeyId = String(process.env.S3_ACCESS_KEY || '').trim();
const secretAccessKey = String(process.env.S3_SECRET_KEY || '').trim();
const configured = Boolean(bucket && accessKeyId && secretAccessKey);

const client = configured ? new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey }
}) : null;

function decodeFileName(value) {
  const raw = String(value || 'attachment');
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

const SAFE_MEDIA_TYPES = new Map([
  ['image/jpeg', { mediaType: 'image', extension: '.jpg' }],
  ['image/png', { mediaType: 'image', extension: '.png' }],
  ['image/webp', { mediaType: 'image', extension: '.webp' }],
  ['image/gif', { mediaType: 'image', extension: '.gif' }],
  ['image/heic', { mediaType: 'image', extension: '.heic' }],
  ['image/heif', { mediaType: 'image', extension: '.heif' }],
  ['image/avif', { mediaType: 'image', extension: '.avif' }],
  ['video/mp4', { mediaType: 'video', extension: '.mp4' }],
  ['video/quicktime', { mediaType: 'video', extension: '.mov' }],
  ['video/webm', { mediaType: 'video', extension: '.webm' }],
  ['video/x-m4v', { mediaType: 'video', extension: '.m4v' }],
  ['video/x-msvideo', { mediaType: 'video', extension: '.avi' }]
]);

function mediaDefinition(contentType) {
  return SAFE_MEDIA_TYPES.get(String(contentType || '').toLowerCase().split(';')[0].trim()) || null;
}

function extensionFor(contentType, fileName) {
  const definition = mediaDefinition(contentType);
  return definition ? definition.extension : '';
}

function safeUploadId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(id) ? id : '';
}

async function health() {
  if (!configured) return { configured: false, ok: true, mode: 'cloudflare-media' };
  const startedAt = Date.now();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return { configured: true, ok: true, mode: 'timeweb-s3', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { configured: true, ok: false, mode: 'timeweb-s3', latencyMs: Date.now() - startedAt, message: error.message };
  }
}

async function uploadStream({ body, contentType, contentLength, fileName, uploadId }) {
  if (!configured) throw new Error('S3_NOT_CONFIGURED');
  const decodedName = decodeFileName(fileName);
  const definition = mediaDefinition(contentType);
  if (!definition) {
    const error = new Error('Можно прикреплять только фото или видео.');
    error.code = 'UNSUPPORTED_MEDIA';
    throw error;
  }
  const safeContentType = String(contentType || '').toLowerCase().split(';')[0].trim();
  const normalizedUploadId = safeUploadId(uploadId);
  const key = normalizedUploadId
    ? 'chat/' + normalizedUploadId + extensionFor(safeContentType, decodedName)
    : crypto.randomUUID() + extensionFor(safeContentType, decodedName);

  // A retry carries the same upload id. If the first request completed but its
  // response was lost, reuse that immutable object instead of creating or
  // overwriting another copy. Drain the duplicate HTTP request body so the
  // connection can close cleanly.
  if (normalizedUploadId && await hasObject(key)) {
    if (body && typeof body.resume === 'function') body.resume();
    return { key, mediaType: definition.mediaType, reused: true };
  }

  const uploader = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: safeContentType,
      ContentDisposition: 'inline',
      Metadata: {
        originalname: encodeURIComponent(decodedName).slice(0, 900),
        ...(normalizedUploadId ? { uploadid: normalizedUploadId } : {})
      },
      ...(Number(contentLength) > 0 ? { ContentLength: Number(contentLength) } : {})
    },
    queueSize: 3,
    partSize: 5 * 1024 * 1024,
    leavePartsOnError: false
  });
  await uploader.done();
  return { key, mediaType: definition.mediaType };
}

async function getObject(key, range) {
  if (!configured) throw new Error('S3_NOT_CONFIGURED');
  return client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: String(key || ''),
    ...(range ? { Range: String(range) } : {})
  }));
}

async function putBuffer(key, body, contentType, {ifAbsent=false}={}) {
  if (!configured) throw new Error('S3_NOT_CONFIGURED');
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: String(key || ''),
    Body: body,
    ContentType: String(contentType || 'application/octet-stream'),
    ContentDisposition: 'inline',
    ...(ifAbsent ? { IfNoneMatch: '*' } : {})
  }));
}

async function hasObject(key) {
  if (!configured) return false;
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: String(key || '') }));
    return true;
  } catch (error) {
    const status = error && (error.$metadata?.httpStatusCode || error.statusCode);
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return false;
    throw error;
  }
}

async function removeObject(key) {
  if (!configured) return false;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: String(key || '') }));
  return true;
}

async function sha256Object(key) {
  if (!configured) throw new Error('S3_NOT_CONFIGURED');

  const object = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: String(key || '')
  }));
  const hash = crypto.createHash('sha256');
  const body = object.Body;

  if (!body) throw new Error('S3_OBJECT_BODY_MISSING');

  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) hash.update(chunk);
  } else {
    hash.update(Buffer.from(await body.transformToByteArray()));
  }

  return hash.digest('hex');
}

module.exports = {
  configured,
  bucket,
  health,
  uploadStream,
  getObject,
  putBuffer,
  hasObject,
  removeObject,
  sha256Object,
  mediaDefinition
};
