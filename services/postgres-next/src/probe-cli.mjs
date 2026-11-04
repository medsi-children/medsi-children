import pg from 'pg';
import {readPostgresConfig} from './connection.mjs';

// Read-only check for the purchased Timeweb PostgreSQL instance.
// Absolutely no patient records, passwords or connection URIs are printed.
export async function probePostgresNext(env=process.env) {
  const options=readPostgresConfig(env);
  const pool=new pg.Pool({...options,max:1,statement_timeout:8000});
  try {
    const version=await pool.query("SELECT current_setting('server_version_num')::integer AS version");
    const v=Number(version.rows[0]?.version||0);
    if(v<180000||v>=190000)throw new Error('PostgreSQL server version is not 18.');
    const result=await pool.query(`
      SELECT count(*)::integer AS tables
      FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
    `);
    const tables=Number(result.rows[0]?.tables||0);
    return {ok:true,major:18,tables,schemaReady:tables===27};
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
      ' tables='+x.tables+' schema_ready='+x.schemaReady);
  }).catch(()=>{
    console.error('MEDSI_PG_PROBE_FAILED');
    process.exitCode=1;
  });
}
