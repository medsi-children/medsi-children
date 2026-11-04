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

test('D1 chat related streams preserve timestamp ties, unread state and historic request keys',async()=>{
  const {deriveD1ChatRelatedStreams}=await import('../src/d1-chat-capture.mjs');
  const first={...fixture,client_message_id:'fictional-first',type:'text',status:'active',file_id:'',reply_to_key:''};
  const edited={...first,message_key:'fictional-edited',client_message_id:'fictional-edited',
    side:'educator',read_by_parent:0,read_by_educator:1,edited_at:1700000000001};
  const deleted={...fixture,message_key:'fictional-deleted',created_at:1700000000002};
  const pin={phone10:first.phone10,bucket:'unread',updated_at:1700000000003};
  const streams=deriveD1ChatRelatedStreams([first,edited,deleted],[pin]);
  assert.deepEqual(streams.chat_thread_state,[{phone10:first.phone10,last_message_key:edited.message_key,
    last_side:'educator',last_type:'text',last_text:edited.text,last_at:'1700000000000',
    educator_has_unread:true,parent_has_unread:true}]);
  assert.match(streams.chat_message_dedup[0].payload_hash,/^[a-f0-9]{64}$/);
  assert.equal(streams.chat_message_dedup[1].payload_hash,null);
  assert.equal(streams.chat_message_dedup[2].payload_hash,null);
  assert.deepEqual(streams.chat_pins,[{...pin,updated_at:'1700000000003'}]);
  assert.throws(()=>deriveD1ChatRelatedStreams([first],[pin,pin]),/ambiguous/);
});

test('D1 media inventory counts unresolved sources and refuses to infer shared ownership',async()=>{
  const {inventoryD1ChatMedia}=await import('../src/d1-chat-capture.mjs');
  const repeated={...fixture,message_key:'second',client_message_id:'second',status:'active'};
  const conflict={...repeated,phone10:'9000000002',message_key:'third'};
  const unresolved={...repeated,file_id:'old-unclassified-id',message_key:'fourth',client_message_id:'fourth'};
  const missing={...repeated,file_id:'',message_key:'fifth',client_message_id:'fifth'};
  const {objects,summary}=inventoryD1ChatMedia([fixture,repeated,conflict,unresolved,missing]);
  assert.deepEqual(summary,{s3:0,kv:1,drive:0,unresolved:1,ownershipConflicts:1,missingReferences:1});
  assert.deepEqual(objects[0],{fileId:fixture.file_id,source:'kv',phone10:null,
    activeReferences:2,deletedReferences:1});
});
