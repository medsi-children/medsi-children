import pg from 'pg';
import {SCHEMA_SQL} from './schema-contract.mjs';

// PostgreSQL adapter for the existing NEXT service contracts.
// Parameterized PostgreSQL statements retain the application's [rows]
// contract; transactions use one connection and fail closed on errors.
const IDENTIFIER = Symbol('allowlisted-pg-identifier');
const schema = SCHEMA_SQL;
const primaryKeys = new Map();
const allowedIdentifiers = new Set();
for (const match of schema.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
  const key = /PRIMARY KEY\s*\(([^)]+)\)/i.exec(match[2]);
  if (key) primaryKeys.set(match[1], key[1].split(',').map(part => part.trim()));
  allowedIdentifiers.add(match[1]);
  for (const col of match[2].matchAll(/^\s*([a-z_][a-z_0-9]*)\s+(?:TEXT|BIGINT|BOOLEAN|BYTEA)\b/gim)) {
    allowedIdentifiers.add(col[1]);
  }
}
if (primaryKeys.size !== 27) throw new Error('PostgreSQL schema metadata mismatch.');

export function normalizePgValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

export function compilePgQuery(strings, values, {upsert = false} = {}) {
  if (!Array.isArray(strings) || strings.length !== values.length + 1) {
    throw new Error('Invalid SQL template.');
  }
  let statement = '';
  const parameters = [];
  for (let index = 0; index < values.length; index++) {
    statement += strings[index];
    const value = values[index];
    if (value && typeof value === 'object' && value[IDENTIFIER]) {
      if (!allowedIdentifiers.has(value[IDENTIFIER])) throw new Error('Unapproved SQL identifier.');
      statement += '"' + value[IDENTIFIER] + '"';
    } else {
      parameters.push(normalizePgValue(value));
      statement += '$' + parameters.length;
    }
  }
  statement += strings[strings.length - 1];
  if (upsert) {
    const insert = /^\s*INSERT\s+INTO\s+([a-z_]+)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*;?\s*$/i.exec(statement);
    if (!insert) throw new Error('Unsupported PostgreSQL upsert statement.');
    const table = insert[1], keys = primaryKeys.get(table);
    if (!keys) throw new Error('Unknown PostgreSQL upsert table.');
    const columns = insert[2].split(',').map(part => part.trim());
    if (!columns.every(name => /^[a-z_][a-z_0-9]*$/i.test(name))) throw new Error('Invalid PostgreSQL upsert columns.');
    if (!keys.every(key => columns.includes(key))) throw new Error('PostgreSQL upsert omits primary key.');
    const update = columns.filter(col => !keys.includes(col))
      .map(col => '"' + col + '" = EXCLUDED."' + col + '"').join(', ');
    statement = 'INSERT INTO "' + table + '" (' + columns.map(col => '"' + col + '"').join(', ') +
      ') VALUES (' + insert[3] + ') ON CONFLICT (' +
      keys.map(key => '"' + key + '"').join(', ') + ') ' +
      (update ? 'DO UPDATE SET ' + update : 'DO NOTHING');
  }
  return { text: statement, values: parameters };
}

export function createPostgresSql(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('PostgreSQL client required.');
  }
  const execute = client => {
    const run = async (strings, ...values) => {
      const result = await client.query(compilePgQuery(strings, values));
      return [result.rows || []];
    };
    run.upsert = async (strings, ...values) => {
      const result = await client.query(compilePgQuery(strings, values, {upsert:true}));
      return [result.rows || []];
    };
    return run;
  };
  const sql = execute(pool);
  sql.upsert = async (strings, ...values) => {
    const result = await pool.query(compilePgQuery(strings, values, {upsert:true}));
    return [result.rows || []];
  };
  sql.identifier = name => {
    if (!allowedIdentifiers.has(name)) throw new Error('Unapproved SQL identifier.');
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
    throw new Error('PostgreSQL NEXT stand mode must be explicitly enabled.');
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
