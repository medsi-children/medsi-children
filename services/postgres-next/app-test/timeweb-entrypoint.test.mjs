import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const entry=fileURLToPath(new URL('../../../server.js',import.meta.url));

test('Timeweb PM2 server.js fails closed when the stand secrets are absent',()=>{
  const result=spawnSync(process.execPath,[entry],{
    cwd:path.dirname(entry),
    env:{...process.env,MEDSI_NEXT_STAND:'1',
      MEDSI_NEXT_PG_ENABLED:'1',
      NEXT_SESSION_SECRET:'',
      NEXT_TUTOR_LOGIN:'',
      NEXT_TUTOR_PASSWORD:'',
      NEXT_TUTOR_VERSION:''},
    encoding:'utf8',
    timeout:12000
  });
  // The HTTP listener intentionally stays alive in diagnostic mode, so
  // a timeout indicates the fail-closed stand is reachable by Timeweb.
  assert.equal(result.error?.code,'ETIMEDOUT');
  assert.match(result.stdout,/MEDSI_NEXT_STAND_HTTP_LISTENING/);
  assert.match(result.stderr,/MEDSI_NEXT_STAND_BOOT_FAILED: STAND_ENV_INVALID/);
  assert.doesNotMatch(result.stdout+'\n'+result.stderr,/Medsi Timeweb gateway listening/);
  assert.doesNotMatch(result.stdout+'\n'+result.stderr,/TIMEWEB_SESSION_BRIDGE_FAILED/);
});
