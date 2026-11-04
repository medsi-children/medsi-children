import pg from 'pg';
import { readPostgresConfig } from './connection.mjs';
import {SCHEMA_INDEXES,SCHEMA_SQL,SCHEMA_TABLES,schemaMatches} from './schema-contract.mjs';

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
    const existing = await client.query(`
      SELECT count(*)::integer AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp_%'
        AND n.nspname NOT LIKE 'pg_toast_temp_%'
        AND c.relkind IN ('r','p','v','m','S','f','i','I')
    `);
    if (existing.rows[0].n !== 0) throw new Error('Database contains user relations; refusing to modify.');
    await client.query(SCHEMA_SQL);
    const tableResult=await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"
    );
    const indexResult=await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public'"
    );
    const otherRelations=await client.query(`SELECT count(*)::integer AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT IN ('public','pg_catalog','information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp_%'
        AND n.nspname NOT LIKE 'pg_toast_temp_%'
        AND c.relkind IN ('r','p','v','m','S','f','i','I')`);
    if(!schemaMatches(tableResult.rows.map(row=>row.table_name),
      indexResult.rows.map(row=>row.indexname),otherRelations.rows[0]?.n)){
      throw new Error('Installed PostgreSQL schema does not match the approved schema contract.');
    }
    await client.query('COMMIT');
    return { ok: true, tables: SCHEMA_TABLES.length, indexes: SCHEMA_INDEXES.length };
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
    console.log('MEDSI_PG_SCHEMA_INSTALLED tables=' + result.tables+' indexes='+result.indexes);
  }).catch(() => {
    console.error('MEDSI_PG_SCHEMA_NOT_INSTALLED');
    process.exitCode = 1;
  });
}
