import test from 'node:test';
import assert from 'node:assert/strict';
import {connectPostgresNext} from '../src/connection.mjs';
import {installSchema} from '../src/schema-cli.mjs';
import {captureD1ChatMessageManifest,importD1ChatMessages} from '../src/d1-chat-capture.mjs';

const env=process.env;
const disposable=env.CI==='true' && env.PG_TEST_INSECURE_LOCAL==='1' &&
  env.PGHOST==='127.0.0.1' && env.PGDATABASE==='medsi_chat_import' && env.PGUSER==='medsi_ci';

test('D1 chat baseline imports once, verifies PostgreSQL data, and refuses mismatches',
  {skip:!disposable},async()=>{
    await installSchema({...env,PG_SCHEMA_CONFIRM:'CREATE_SCHEMA_IN_EMPTY_DATABASE'});
    const connection=await connectPostgresNext(env);
    try{
      const rows=[{
        phone10:'9000000001',message_key:'fictional-message',client_message_id:'fictional-client',
        side:'parent',type:'text',text:'Синтетическая запись',file_id:'',
        reply_to_key:'',reaction:'',status:'active',created_at:1700000000000,
        edited_at:null,delete_after:null,read_by_parent:1,read_by_educator:0
      }];
      const hmacKey='synthetic-chat-import-test-key-123456789';
      const options={hmacKey,explicitImport:true,freezeConfirmed:true,
        expectedManifest:captureD1ChatMessageManifest(rows,hmacKey)};
      await assert.rejects(importD1ChatMessages(connection.sql,rows,{...options,freezeConfirmed:false}),/approval/);
      assert.deepEqual(await importD1ChatMessages(connection.sql,rows,options),{count:1,alreadyImported:false});
      assert.deepEqual(await importD1ChatMessages(connection.sql,rows,options),{count:1,alreadyImported:true});
      const changed=[{...rows[0],text:'Другая синтетическая запись'}];
      await assert.rejects(importD1ChatMessages(connection.sql,changed,options),/manifest mismatch/);
      await assert.rejects(importD1ChatMessages(connection.sql,changed,{...options,
        expectedManifest:captureD1ChatMessageManifest(changed,hmacKey)}),/differ from the baseline/);
    }finally{
      await connection.driver.close();
    }
  });
