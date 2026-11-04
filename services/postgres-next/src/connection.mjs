import { readFileSync } from 'node:fs';
import pg from 'pg';

// PostgreSQL adapter for the existing NEXT service contracts.
// A tagged statement resolves to [rows], matching the YDB query client's
// shape; transactions use a single connection and fail closed on errors.
const IDENTIFIER = Symbol('allowlisted-pg-identifier');
const schema = readFileSync(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
const primaryKeys = new Map();
for (const match of schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
  const key = /PRIMARY KEY\s*\(([^)]+)\)/i.exec(match[2]);
  if (key) primaryKeys.set(match[1], key[1].split(',').map(part => part.trim()));
}
if (primaryKeys.size !== 27) throw new Error('PostgreSQL schema metadata mismatch.');

export function normalizePgValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value);
  // Legacy YDB service modules still build Uint64 values. Convert their
  // underlying integer without ever submitting YDB objects to node-postgres.
  if (value && typeof value === 'object' && value.constructor?.name === 'Uint64') {
    const integer = value.value ?? value.toString();
    const text = String(integer);
    if (!/^\d+$/.test(text)) throw new Error('Invalid Uint64 parameter.');
    return text;
  }
  return value;
}

export function compilePgQuery(strings, values) {
  if (!Array.isArray(strings) || strings.length !== values.length + 1) {
    throw new Error('Invalid SQL template.');
  }
  let statement = '';
  const parameters = [];
  for (let index = 0; index < values.length; index++) {
    statement += strings[index];
    const value = values[index];
    if (value && typeof value === 'object' && value[IDENTIFIER]) {
      if (!primaryKeys.has(value[IDENTIFIER])) throw new Error('Unapproved SQL identifier.');
      statement += '"' + value[IDENTIFIER] + '"';
    } else {
      parameters.push(normalizePgValue(value));
      statement += '$' + parameters.length;
    }
  }
  statement += strings[strings.length - 1];
  // YDB VIEW clauses are index hints. PostgreSQL uses its own indexes.
  statement = statement.replace(/\s+VIEW\s+chat_messages_by_(?:key|file)\b/gi, '');
  const upsert = /^\s*UPSERT\s+INTO\s+([a-z_]+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*;?\s*$/i.exec(statement);
  if (/^\s*UPSERT\b/i.test(statement)) {
    if (!upsert) throw new Error('Unsupported UPSERT statement.');
    const table = upsert[1], keys = primaryKeys.get(table);
    if (!keys) throw new Error('Unknown UPSERT table.');
    const columns = upsert[2].split(',').map(part => part.trim());
    if (!columns.every(name => /^[a-z_][a-z_0-9]*$/i.test(name))) throw new Error('Invalid UPSERT columns.');
    if (!keys.every(key => columns.includes(key))) throw new Error('UPSERT omits primary key.');
    const update = columns.filter(col => !keys.includes(col))
      .map(col => '"' + col + '" = EXCLUDED."' + col + '"').join(', ');
    statement = 'INSERT INTO "' + table + '" (' + columns.map(col => '"' + col + '"').join(', ') +
      ') VALUES (' + upsert[3] + ') ON CONFLICT (' +
      keys.map(key => '"' + key + '"').join(', ') + ') ' +
      (update ? 'DO UPDATE SET ' + update : 'DO NOTHING');
  }
  return { text: statement, values: parameters };
}

export function createPostgresSql(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('PostgreSQL client required.');
  }
  const execute = client => async (strings, ...values) => {
    const result = await client.query(compilePgQuery(strings, values));
    return [result.rows || []];
  };
  const sql = execute(pool);
  sql.identifier = name => {
    if (!primaryKeys.has(name)) throw new Error('Unapproved SQL identifier.');
    return Object.freeze({ [IDENTIFIER]: name });
  };
  sql.begin = async (options, callback) => {
    if (typeof callback !== 'function') throw new Error('Transaction callback required.');
    const readOnly = options?.isolation === 'snapshotReadOnly';
    const begin = readOnly
      ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
      : 'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE';
    const maxAttempts = options?.idempotent ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const client = await pool.connect();
      try {
        await client.query(begin);
        const tx = execute(client);
        tx.identifier = sql.identifier;
        const value = await callback(tx);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
        if (attempt + 1 === maxAttempts || !['40001', '40P01'].includes(error?.code)) throw error;
      } finally {
        client.release();
      }
    }
    throw new Error('Transaction retry budget exhausted.');
  };
  return sql;
}

export function readPostgresConfig(env = process.env) {
  if (env.MEDSI_NEXT_PG_ENABLED !== '1' || env.MEDSI_NEXT_STAND !== '1') {
    throw new Error('PostgreSQL NEXT requires explicit isolated opt-in.');
  }
  const host = String(env.PGHOST || '').trim();
  const port = Number(env.PGPORT || 5432);
  const database = String(env.PGDATABASE || '').trim();
  const user = String(env.PGUSER || '').trim();
  const password = String(env.PGPASSWORD || '');
  if (!host || !database || !user || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PostgreSQL NEXT connection settings incomplete.');
  }
  // An insecure local connection is permissible ONLY inside isolated CI.
  const localCI = env.CI === 'true' && env.NODE_ENV === 'test' &&
    env.PG_TEST_INSECURE_LOCAL === '1' && ['127.0.0.1', 'localhost'].includes(host);
  const caPem = env.PG_SSL_CA_B64
    ? Buffer.from(String(env.PG_SSL_CA_B64), 'base64').toString('utf8')
    : String(env.PG_SSL_CA_PEM || '');
  if (!localCI && (!caPem.includes('-----BEGIN CERTIFICATE-----') ||
      !caPem.includes('-----END CERTIFICATE-----'))) {
    throw new Error('PostgreSQL NEXT requires a trusted TLS CA certificate.');
  }
  return {
    host, port, database, user, password,
    ssl: localCI ? false : { ca: caPem, rejectUnauthorized: true },
    max: 4, application_name: 'medsi-next-isolated',
    connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000,
    statement_timeout: 20000
  };
}

export async function connectPostgresNext(env = process.env) {
  const config = readPostgresConfig(env);
  const pool = new pg.Pool(config);
  try {
    await pool.query('SELECT 1 AS ok');
    return { sql: createPostgresSql(pool), driver: { close: () => pool.end() } };
  } catch (_) {
    await pool.end().catch(() => {});
    throw new Error('PostgreSQL NEXT connection failed.');
  }
}
