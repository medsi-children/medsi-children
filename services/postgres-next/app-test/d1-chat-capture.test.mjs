import test from 'node:test';
import assert from 'node:assert/strict';
import {generateManifest} from '../app/migration-audit.mjs';
import {normalizeD1ChatMessages,captureD1ChatMessageManifest} from '../src/d1-chat-capture.mjs';

const key='synthetic-key-for-tests-only-123456789';
const fixture={
  phone10:'9000000001',message_key:'fictional-message',client_message_id:'fictional-client',
  side:'parent',type:'image',text:'Синтетическая запись',file_id:'kv:fictional-image',
  reply_to_key:'fictional-older-message',reaction:'👍',status:'deleted',created_at:1700000000000,
  edited_at:null,delete_after:1700000000001,read_by_parent:1,read_by_educator:0
};

test('D1 chat capture matches PostgreSQL types and preserves media and deletion history',()=>{
  const pgRow={...fixture,created_at:'1700000000000',delete_after:'1700000000001',
    read_by_parent:true,read_by_educator:false};
  assert.deepEqual(normalizeD1ChatMessages([fixture]),[pgRow]);
  assert.deepEqual(captureD1ChatMessageManifest([fixture],key),
    generateManifest('chat_messages',[pgRow],key));
});

test('D1 chat capture rejects ambiguous identities and lossy values',()=>{
  assert.throws(()=>normalizeD1ChatMessages([fixture,fixture]),/ambiguous/);
  assert.throws(()=>normalizeD1ChatMessages([fixture,{...fixture,message_key:'another'}]),/ambiguous/);
  for(const patch of [{created_at:Number.MAX_SAFE_INTEGER+1},{read_by_parent:2},{type:'unknown'},{phone10:''}]){
    assert.throws(()=>normalizeD1ChatMessages([{...fixture,...patch}]),/ambiguous/);
  }
});
