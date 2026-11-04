import { readFileSync } from 'node:fs';
import pg from 'pg';
import { readPostgresConfig } from './connection.mjs';

// Manual, one-time initialization for a NEW empty PostgreSQL database.
// Deliberately no HTTP endpoint, no automatic schema creation at app startup,
// no imports of patient records, and no migration secrets in logs.
export async function installSchema(env = process.env) {
  if (env.PG_SCHEMA_CONFIRM !== 'CREATE_SCHEMA_IN_EMPTY_DATABASE') {
    throw new Error('Explicit empty-database initialization confirmation required.');
  }
  const pool = new pg.Pool(readPostgresConfig(env));
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const existing = await client.query(
      "SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    );
    if (existing.rows[0].n !== 0) throw new Error('Database is not empty; refusing to modify.');
    const schema = readFileSync(new URL('../sql/001_initial.sql', import.meta.url), 'utf8');
    await client.query(schema);
    await client.query('COMMIT');
    return { ok: true, tables: 27 };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  installSchema().then(result => {
    console.log('MEDSI_PG_SCHEMA_INSTALLED tables=' + result.tables);
  }).catch(() => {
    console.error('MEDSI_PG_SCHEMA_NOT_INSTALLED');
    process.exitCode = 1;
  });
}
