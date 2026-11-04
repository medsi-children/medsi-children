import { createHmac, timingSafeEqual } from 'node:crypto';

// Aggregated keyed digests for comparing live D1/Sheets exports with PostgreSQL.
// Never print, persist or commit real input rows, HMAC keys or raw identifiers.
export const REQUIRED_STREAMS = Object.freeze([
  'parents', 'admissions', 'name_variants',
  'raw_reports', 'current_reports', 'report_history',
  'chat_messages', 'chat_pins',
  'passkeys', 'auth_profiles', 'push_subscriptions'
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
