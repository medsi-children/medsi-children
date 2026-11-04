import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyD1ChatMedia,prepareChatMediaImport} from '../src/chat-media-copy.mjs';

const row={phone10:'9000000001',message_key:'synthetic-message',client_message_id:'',
  side:'parent',type:'image',text:'',file_id:'kv:synthetic-image',reply_to_key:'',
  reaction:'',status:'active',created_at:1700000000000,edited_at:null,delete_after:null,
  read_by_parent:1,read_by_educator:0};
const bytes=Buffer.from('synthetic image bytes');
const key='synthetic-key-for-tests-only-123456789';
test('attachment copy verifies bytes and reuses an intact object without overwriting',async()=>{
  const objects=new Map();
  let writes=0;
  const destination={
    configured:true,
    hasObject:async id=>objects.has(id),
    putBuffer:async(id,body,type,opts)=>{
      assert.deepEqual(opts,{ifAbsent:true});
      assert.equal(type,'image/png');
      objects.set(id,body);writes++;
    },
    sha256Object:async id=>createHash('sha256').update(objects.get(id)).digest('hex')
  };
  const options={destination,hmacKey:key,explicitCopy:true,
    readSource:async(source,id,maxBytes)=>{
      assert.equal(source,'kv');
      assert.equal(id,row.file_id);
      assert.equal(maxBytes,100*1024*1024);
      return {body:bytes,contentType:'image/png'};
    }};
  await assert.rejects(copyD1ChatMedia([row],{...options,explicitCopy:false}),/approval/);
  const first=await copyD1ChatMedia([row],options);
  assert.match(first[0].fileId,/^s3:chat\/[a-f0-9]{64}\.png$/);
  assert.deepEqual(await copyD1ChatMedia([row],options),first);
  assert.equal(writes,1);
  const planned=prepareChatMediaImport([row],first);
  assert.equal(planned.messages[0].file_id,first[0].fileId);
  assert.deepEqual(planned.chatMedia,[{file_id:first[0].fileId,phone10:row.phone10,
    uploaded_at:String(row.created_at)}]);
  assert.equal(planned.s3Objects[0].sha256,first[0].sha256);
  assert.equal(row.file_id,'kv:synthetic-image');
  assert.throws(()=>prepareChatMediaImport([row],[{...first[0],phone10:'9000000002'}]),/owner/);
  objects.set(first[0].fileId.slice(3),Buffer.from('different bytes'));
  await assert.rejects(copyD1ChatMedia([row],options),/verification failed/);
  assert.equal(writes,1);
  await assert.rejects(copyD1ChatMedia([{...row,file_id:''}],options),/unresolved/);
});
