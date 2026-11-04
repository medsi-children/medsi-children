import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {connectPostgresNext} from '../src/connection.mjs';
import {capturePostgresManifests} from '../src/postgres-manifests.mjs';

const env=process.env;
assert.ok(env.CI==='true' && env.PG_TEST_INSECURE_LOCAL==='1' &&
  env.PGHOST==='127.0.0.1' && env.PGDATABASE==='medsi_ci' && env.PGUSER==='medsi_ci',
  'Disposable PostgreSQL CI only.');

const key=randomBytes(32).toString('hex');
async function capture(database) {
  const connection=await connectPostgresNext({...env,PGDATABASE:database});
  try {
    return await capturePostgresManifests(connection.sql,key);
  }finally{
    await connection.driver.close();
  }
}
try{
  const [source,restored]=await Promise.all([capture('medsi_ci'),capture('medsi_restore')]);
  assert.equal(source.length,25);
  assert.ok(source.some(item=>item.stream==='parent_profiles'&&item.count>0));
  assert.ok(source.some(item=>item.stream==='raw_reports'&&item.count>0));
  for(let i=0;i<source.length;i++){
    const a=source[i],b=restored[i];
    if(!b||a.stream!==b.stream||a.count!==b.count||a.duplicateRows!==b.duplicateRows||a.digest!==b.digest){
      throw new Error('Restored stream mismatch: '+a.stream);
    }
  }
  console.log('MEDSI_PG_RESTORE_CONTENT_OK streams='+source.length);
}catch(_){
  console.error('MEDSI_PG_RESTORE_CONTENT_FAILED');
  process.exitCode=1;
}
