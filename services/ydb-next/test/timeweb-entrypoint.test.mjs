import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const entry=fileURLToPath(new URL('../../../server.js',import.meta.url));

test('Timeweb PM2 server.js boots NEXT only and fails closed without standalone credentials',()=>{
  const result=spawnSync(process.execPath,[entry],{
    cwd:path.dirname(entry),
    env:{...process.env,MEDSI_NEXT_STAND:'1',
      MEDSI_NEXT_YDB_ENABLED:'0',
      NEXT_SESSION_SECRET:'',
      NEXT_TUTOR_LOGIN:'',
      NEXT_TUTOR_PASSWORD:'',
      NEXT_TUTOR_VERSION:''},
    encoding:'utf8',
    timeout:12000
  });
  if(result.error)throw result.error;
  assert.notEqual(result.status,0,'missing test-only secrets must prevent startup');
  assert.match(result.stderr,/MEDSI_NEXT_STAND_START_FAILED/);
  assert.doesNotMatch(result.stdout+'\n'+result.stderr,/Medsi Timeweb gateway listening/);
  assert.doesNotMatch(result.stdout+'\n'+result.stderr,/TIMEWEB_SESSION_BRIDGE_FAILED/);
});
