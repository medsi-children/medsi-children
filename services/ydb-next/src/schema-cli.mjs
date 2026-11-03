// Apply the test schema explicitly. No production migration or real data import.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {connectYdbNext} from './connection.mjs';

export function splitSchemaStatements(source) {
  const cleaned=String(source||'').split('\n')
    .filter(line=>!/^\s*--/.test(line))
    .join('\n');
  const statements=cleaned.split(';').map(s=>s.trim()).filter(Boolean);
  if(statements.length<15 || statements.some(sql=>!/^CREATE TABLE IF NOT EXISTS [a-z_]+\s*\(/i.test(sql))){
    throw new Error('Unexpected schema content; refusing to run.');
  }
  return statements;
}
export async function applyTestSchema({sql,source}) {
  if(typeof sql!=='function')throw new Error('YDB query executor unavailable.');
  const statements=splitSchemaStatements(source);
  for(const statement of statements) {
    // Statements are reviewed static repository SQL, never interpolated input.
    await sql`${sql.unsafe(statement)}`;
  }
  return statements.length;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const env=process.env;
  if(env.MEDSI_NEXT_STAND!=='1'||env.MEDSI_NEXT_APPLY_TEST_SCHEMA!=='YES'){
    console.error('Schema bootstrap disabled; enable isolated test stand and explicit schema confirmation.');
    process.exitCode=2;
  } else {
    let driver;
    try{
      const connection=await connectYdbNext(env);
      driver=connection.driver;
      const source=await readFile(new URL('../sql/001_initial.sql',import.meta.url),'utf8');
      const count=await applyTestSchema({sql:connection.sql,source});
      console.log('Isolated YDB test tables verified:',count);
    }catch(_){
      console.error('Isolated YDB schema setup failed. No source data was modified.');
      process.exitCode=1;
    }finally{
      if(driver&&typeof driver.destroy==='function')await driver.destroy().catch(()=>{});
    }
  }
}
