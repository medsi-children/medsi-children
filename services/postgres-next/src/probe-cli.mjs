import pg from 'pg';
import {readPostgresConfig} from './connection.mjs';
import {SCHEMA_INDEXES,schemaMatches} from './schema-contract.mjs';

// Read-only check for the purchased Timeweb PostgreSQL instance.
// Absolutely no patient records, passwords or connection URIs are printed.
export async function probePostgresNext(env=process.env) {
  const options=readPostgresConfig(env);
  const pool=new pg.Pool({...options,max:1,statement_timeout:8000});
  try {
    const version=await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    const v=Number(version.rows[0]?.version||0);
    if(v<180000||v>=190000)throw new Error('PostgreSQL server version is not 18.');
    const [tableResult,indexResult,otherRelations]=await Promise.all([
      pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"),
      pool.query("SELECT indexname FROM pg_indexes WHERE schemaname='public'"),
      pool.query(`SELECT count(*)::integer AS n
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('public','pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp_%'
          AND n.nspname NOT LIKE 'pg_toast_temp_%'
          AND c.relkind IN ('r','p','v','m','S','f','i','I')`)
    ]);
    const tables=tableResult.rows.length;
    return {ok:true,major:18,tables,indexes:SCHEMA_INDEXES.length,
      schemaReady:schemaMatches(tableResult.rows.map(row=>row.table_name),
        indexResult.rows.map(row=>row.indexname),otherRelations.rows[0]?.n)};
  } catch (_) {
    // CA, account names and connection URLs may be part of native pg errors.
    throw new Error('PostgreSQL TLS probe failed; review Timeweb network, CA and credentials securely.');
  } finally {
    await pool.end().catch(()=>{});
  }
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  probePostgresNext().then(x=>{
    console.log('MEDSI_PG_PROBE_OK version='+x.major+
      ' tables='+x.tables+' indexes='+x.indexes+' schema_ready='+x.schemaReady);
  }).catch(()=>{
    console.error('MEDSI_PG_PROBE_FAILED');
    process.exitCode=1;
  });
}
