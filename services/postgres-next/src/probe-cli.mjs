import pg from 'pg';
import {readPostgresConfig} from './connection.mjs';
import {SCHEMA_INDEXES,SCHEMA_TABLES,schemaMatches} from './schema-contract.mjs';

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
    const actualTables=tableResult.rows.map(row=>String(row.table_name));
    const actualIndexes=new Set(indexResult.rows.map(row=>String(row.indexname)));
    const legacyReady=schemaMatches(actualTables,[...actualIndexes],otherRelations.rows[0]?.n);
    // After the optional DDL-only contract, admissions is the ONLY missing
    // legacy table. Existing indexes and both child_id report columns remain.
    const currentTables=SCHEMA_TABLES.filter(name=>name!=='admissions');
    const physicalSchemaReady=Number(otherRelations.rows[0]?.n)===0&&
      actualTables.length===currentTables.length&&
      currentTables.every(name=>actualTables.includes(name))&&
      SCHEMA_INDEXES.every(name=>actualIndexes.has(name));
    let currentReady=false;
    if(physicalSchemaReady){
      const columns=await pool.query(`SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name IN
        ('parent_current_reports','parent_report_history')`);
      const keys=new Set(columns.rows.map(x=>x.table_name+'.'+x.column_name));
      currentReady=keys.has('parent_current_reports.child_id')&&
        keys.has('parent_report_history.child_id');
    }
    return {ok:true,major:18,tables:actualTables.length,indexes:SCHEMA_INDEXES.length,
      schemaReady:legacyReady||currentReady};
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
