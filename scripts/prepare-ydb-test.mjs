// Timeweb start entry for the isolated YDB stand. It is safe on restarts:
// schema statements are CREATE IF NOT EXISTS, while the synthetic fixture is
// written once in the same transaction as its completion marker.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {connectYdbNext,closeYdbDriver} from '../services/ydb-next/src/connection.mjs';
import {applyTestSchema} from '../services/ydb-next/src/schema-cli.mjs';
import {seedSyntheticRoster} from '../services/ydb-next/src/seed-demo.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));

export function assertBootstrapEnabled(env) {
  if(env.MEDSI_NEXT_PREPARE_YDB_TEST!=='YES' ||
     env.MEDSI_NEXT_STAND!=='1' ||
     env.MEDSI_NEXT_YDB_ENABLED!=='1' ||
     env.MEDSI_NEXT_YDB_TABLE_SCOPE!=='medsi_next_test') {
    throw new Error('Explicit isolated YDB test bootstrap is not enabled.');
  }
  if(env.MEDSI_NEXT_DELETION_ENABLED==='1') {
    throw new Error('Deletion must remain disabled on the unverified YDB stand.');
  }
}

export function assertStandRuntime(env) {
  if(env.MEDSI_NEXT_STAND!=='1'||
     env.MEDSI_NEXT_YDB_ENABLED!=='1'||
     env.MEDSI_NEXT_YDB_TABLE_SCOPE!=='medsi_next_test') {
    throw new Error('Isolated YDB test runtime is not configured.');
  }
  if(env.MEDSI_NEXT_DELETION_ENABLED==='1') {
    throw new Error('Deletion must remain disabled on the unverified YDB stand.');
  }
}

export async function prepareYdbTest(env=process.env,{onStage=()=>{}}={}) {
  const mark=stage=>{try{onStage(stage);}catch(_){/* diagnostics are optional */}};
  mark('CHECKING_TEST_SETTINGS');
  assertStandRuntime(env);
  if(env.MEDSI_NEXT_PREPARE_YDB_TEST==='YES')assertBootstrapEnabled(env);
  mark('CONNECTING_TO_YDB');
  const connection=await connectYdbNext(env);
  try {
    if(env.MEDSI_NEXT_PREPARE_YDB_TEST==='YES') {
      mark('APPLYING_TEST_SCHEMA');
      const schema=await readFile(new URL('../services/ydb-next/sql/001_initial.sql',import.meta.url),'utf8');
      const statements=await applyTestSchema({sql:connection.sql,source:schema});
      mark('ADDING_SYNTHETIC_FIXTURE');
      const fixture=await seedSyntheticRoster(connection);
      mark('PREPARATION_COMPLETE');
      return {schemaStatements:statements,...fixture};
    }
    mark('CHECKING_PREPARATION_MARKER');
    const [markers]=await connection.sql`SELECT status FROM stand_bootstrap_state
      WHERE bootstrap_id=${'synthetic_roster_v1'} LIMIT 1`;
    if(markers.length!==1||markers[0].status!=='complete') {
      throw new Error('One-time YDB test preparation is not complete.');
    }
    mark('PREPARATION_COMPLETE');
    return {alreadySeeded:true,preparedPreviously:true};
  } finally {
    await closeYdbDriver(connection.driver);
  }
}

function startServer() {
  const child=spawn(process.execPath,['server.js'],{cwd:ROOT,env:process.env,stdio:'inherit'});
  let stopping=false;
  const stop=signal=>{
    if(stopping)return;
    stopping=true;
    child.kill(signal);
  };
  const onTerm=()=>stop('SIGTERM'),onInt=()=>stop('SIGINT');
  process.once('SIGTERM',onTerm);
  process.once('SIGINT',onInt);
  child.once('error',()=>{
    console.error('MEDSI_NEXT_STAND_SERVER_START_FAILED');
    process.exitCode=1;
  });
  child.once('exit',(code,signal)=>{
    process.removeListener('SIGTERM',onTerm);
    process.removeListener('SIGINT',onInt);
    process.exitCode=signal?1:(code??1);
  });
  return child;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]) {
  // Timeweb scans for an open HTTP port during container startup. Start the
  // isolated server first; it binds immediately and reports truthful YDB
  // readiness while this parent process prepares the test schema in parallel.
  const server=startServer();
  let stage='STARTING';
  try {
    const result=await prepareYdbTest(process.env,{onStage:value=>{stage=value;}});
    console.log(result.alreadySeeded
      ?'MEDSI_NEXT_TEST_FIXTURE_ALREADY_PRESENT'
      :'MEDSI_NEXT_TEST_FIXTURE_CREATED');
  } catch (_) {
    // Never print YDB SDK errors, secrets, or fixture contents.
    console.error('MEDSI_NEXT_TEST_PREPARATION_FAILED stage='+stage);
    server.kill('SIGTERM');
    process.exitCode=1;
  }
}
