import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOfflineD1Snapshot} from '../src/d1-offline-snapshot.mjs';

test('offline D1 capture reads the repository schema and returns queue totals only',t=>{
  const dir=mkdtempSync(join(tmpdir(),'medsi-d1-synthetic-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'capture.sqlite');
  const db=new DatabaseSync(file);
  try{
    const migrations=new URL('../../cloudflare/chat-worker/migrations/',import.meta.url);
    for(const name of readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort()){
      db.exec(readFileSync(new URL(name,migrations),'utf8'));
    }
    db.exec(`INSERT INTO chat_messages (message_key,phone10,side,text,created_at)
      VALUES ('synthetic-key','9000000001','parent','synthetic',1700000000000)`);
    db.exec(`INSERT INTO parent_passkeys (credential_id,user_handle,public_key,created_at)
      VALUES ('synthetic-key','synthetic-handle',x'010203',1700000000000)`);
  }finally{db.close();}
  assert.throws(()=>readOfflineD1Snapshot(file,{explicitRead:true}),/approved frozen/);
  const result=readOfflineD1Snapshot(file,{explicitRead:true,freezeConfirmed:true});
  assert.equal(result.messages[0].message_key,'synthetic-key');
  assert.equal(result.passkeys[0].public_key_base64url,'AQID');
  assert.equal(result.operationalCounts.parent_deletion_queue,0);
  assert.equal(Object.hasOwn(result,'parent_deletion_queue'),false);
});
