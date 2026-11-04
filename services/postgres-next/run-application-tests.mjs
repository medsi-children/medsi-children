import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const files=readdirSync(path.join(ROOT,'app-test')).filter(file=>file.endsWith('.test.mjs')).sort();
if(files.length<12)throw new Error('Expected full PostgreSQL application test suite is missing.');
let failed=0;
for(const file of files){
  console.log('\n--- PostgreSQL application test: '+file+' ---');
  const run=spawnSync(process.execPath,['--test',path.join('app-test',file)],{
    cwd:ROOT,stdio:'inherit',env:{...process.env,MEDSI_NEXT_STAND:'0'}
  });
  if(run.status!==0){failed++;console.error('FAILED: '+file);}
}
if(failed) {
  console.error('PostgreSQL application suite failed:',failed,'of',files.length);
  process.exitCode=1;
}else{
  console.log('PostgreSQL application suite passed:',files.length,'test modules');
}
