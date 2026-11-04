import { createHmac, timingSafeEqual } from 'node:crypto';

// Aggregated keyed digests for comparing live D1/Sheets exports with PostgreSQL.
// Never print, persist or commit real input rows, HMAC keys or raw identifiers.
export const REQUIRED_STREAMS = Object.freeze([
  'children', 'admissions', 'parent_profiles', 'name_variants',
  'report_publication_head', 'report_submissions', 'raw_reports',
  'report_ownership', 'parent_current_reports', 'parent_report_history',
  'chat_messages', 'chat_media', 'chat_thread_state', 'chat_message_dedup',
  'chat_pins', 'chat_sessions', 'parent_auth_profiles', 'parent_passkeys',
  'parent_auth_challenges', 'parent_deletion_queue',
  'parent_registration_attempts', 'parent_access_requests',
  'push_subscriptions', 'push_outbox', 'background_jobs',
  's3_objects'
]);

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite value in manifest.');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    if (value instanceof Uint8Array) return canonical([...value]);
    const keys = Object.keys(value).sort();
    if (keys.some(key => typeof value[key] === 'undefined' || typeof value[key] === 'function')) {
      throw new Error('Unsupported field in manifest.');
    }
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('Unsupported value in migration manifest.');
}

function hmac(secret, domain, input) {
  return createHmac('sha256', secret).update(domain + '\u0000' + input, 'utf8').digest('hex');
}

// Use independent 32-byte+ random secret, supplied only in approved runtime.
export function generateManifest(stream, rows, secret) {
  if (!/^[a-z][a-z_0-9-]{1,63}$/.test(stream) || !Array.isArray(rows)) {
    throw new Error('Invalid stream or rows.');
  }
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Migration audit secret must be at least 32 bytes.');
  }
  const itemDigests = rows.map(row => hmac(secret, 'item:' + stream, canonical(row))).sort();
  const duplicates = itemDigests.length - new Set(itemDigests).size;
  return {
    stream,
    count: rows.length,
    duplicateRows: duplicates,
    digest: hmac(secret, 'manifest:' + stream, itemDigests.join('\n'))
  };
}

function orderedManifests(manifests) {
  if (!Array.isArray(manifests)) throw new Error('Manifest list is required.');
  return [...manifests].sort((a, b) => String(a?.stream).localeCompare(String(b?.stream)));
}

function envelopePayload(captureId, manifests) {
  return canonical({captureId, manifests:orderedManifests(manifests)});
}

export function signManifestEnvelope(captureId, manifests, secret) {
  if (typeof captureId !== 'string' || !/^[-A-Za-z0-9_]{12,120}$/.test(captureId) ||
      typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Invalid migration envelope identity or audit key.');
  }
  return {
    captureId,
    manifests:orderedManifests(manifests),
    signature:hmac(secret, 'migration-envelope:v1', envelopePayload(captureId, manifests))
  };
}

export function verifyManifestEnvelope(envelope, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32 ||
      !envelope || typeof envelope.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.signature)) return false;
  let expected;
  try {
    expected = hmac(secret, 'migration-envelope:v1',
      envelopePayload(envelope.captureId, envelope.manifests));
  } catch (_) { return false; }
  const actualBytes = Buffer.from(envelope.signature, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

// Compare only normalized stream snapshots captured behind the same write fence.
// Different capture times cannot prove readiness for the final switch.
export function compareManifests(source, destination, streams = REQUIRED_STREAMS) {
  const byStream = values => new Map(values.map(item => [item.stream, item]));
  if (!Array.isArray(source) || !Array.isArray(destination)) throw new Error('Manifest lists are required.');
  const src = byStream(source);
  const dst = byStream(destination);
  const findings = streams.map(stream => {
    const a = src.get(stream), b = dst.get(stream);
    if (!a || !b) return { stream, status: 'missing' };
    if (!/^[a-f0-9]{64}$/.test(a.digest) || !/^[a-f0-9]{64}$/.test(b.digest)) {
      return { stream, status: 'invalid' };
    }
    const hashesMatch = timingSafeEqual(Buffer.from(a.digest, 'hex'), Buffer.from(b.digest, 'hex'));
    return {
      stream, status: a.count === b.count && hashesMatch ? 'matched' : 'mismatch',
      sourceCount: a.count, destinationCount: b.count
    };
  });
  return { ready: findings.every(item => item.status === 'matched'), findings };
}
