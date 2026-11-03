import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatOperations,messageFromRow} from '../src/chat-operations.mjs';

test('legacy chat wire shape keeps replies, media, reactions and read flags', () => {
  const m=messageFromRow({
    phone10:'9000000001',message_key:'msg-001',side:'parent',type:'image',
    text:'',file_id:'s3:test',reply_to_key:'msg-000',
    reaction:'👍',created_at:1234,read_by_parent:true,read_by_educator:false,status:'active'
  });
  assert.equal(m.messageKey,'msg-001');
  assert.equal(m.fileId,'s3:test');
  assert.equal(m.mediaUrl,'/media/s3/test');
  assert.equal(m.reply.messageKey,'msg-000');
  assert.equal(m.readByEducator,false);
  assert.equal(m.reaction,'👍');
});
function sqlFixture() {
  const data={
    profiles:[
      {phone10:'9000000001',parent_name:'Тестовый родитель',child_id:'c-1',relationship:'Мама'},
      {phone10:'9000000002',parent_name:'Тестовый папа',child_id:'c-1',relationship:'Папа'}
    ],
    children:[{child_id:'c-1',registered_first_name:'Лена',surname:'Тестовая'}],
    states:[
      {phone10:'9000000001',last_side:'parent',last_type:'text',last_text:'Сообщение',last_at:100,educator_has_unread:true},
      {phone10:'9000000002',last_side:'educator',last_type:'image',last_text:'',last_at:200,educator_has_unread:false}
    ],
    pins:[{phone10:'9000000001',bucket:'unread'}]
  };
  const sql={async begin(_opts,run) {
    const tx=async strings=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.includes('FROM chat_thread_state')) return [data.states];
      if(query.includes('FROM chat_pins')) return [data.pins];
      if(query.includes('FROM parent_profiles')) return [data.profiles];
      if(query.includes('FROM children')) return [data.children];
      if(query.includes('FROM chat_messages')) return [[]];
      throw new Error('Unexpected SQL: '+query);
    };
    return run(tx);
  }};
  return {data,sql};
}
test('educator list maintains pin filtering and same-child multiple-parent cards',async()=>{
  const {sql}=sqlFixture();
  const ops=createChatOperations(sql);
  const parentList=await ops.listParents();
  assert.equal(parentList.parents.length,2);
  assert.equal(parentList.parents[0].childName,'Лена Тестовая');
  const all=await ops.listChats();
  assert.equal(all.chats.length,2);
  const unread=await ops.listChats('unread');
  assert.equal(unread.chats.length,1);
  assert.equal(unread.chats[0].phone,'9000000001');
  const read=await ops.listChats('read');
  assert.equal(read.chats.length,1);
  assert.equal(read.chats[0].phone,'9000000002');
});
test('unsupported chat filters and invalid user roles are rejected',async()=>{
  const {sql}=sqlFixture();
  const ops=createChatOperations(sql);
  await assert.rejects(()=>ops.listChats('other'),/Unsupported/);
  await assert.rejects(()=>ops.markRead('visitor','9000000001'),/Unknown role/);
  await assert.rejects(()=>ops.markRead('parent','9000000001',true),/Parent cannot/);
  await assert.rejects(()=>ops.pin('9000000001','unknown'),/Invalid pin/);
});

test('parent-entered child name survives while clinical roster has not been matched',async()=>{
  const {data,sql}=sqlFixture();
  data.profiles=[{phone10:'9000000001',parent_name:'Мама',child_name:'Вася Пробный',
    child_id:'',relationship:'Мама'}];
  const ops=createChatOperations(sql);
  const parents=await ops.listParents();
  assert.equal(parents.parents[0].childName,'Вася Пробный');
  const chats=await ops.listChats();
  assert.equal(chats.chats[0].childName,'Вася Пробный');
  // When the clinical roster is not linked, the opened thread must not lose
  // the parent-provided name that was already visible in the chat list.
  data.children=[];
  const thread=await ops.thread('9000000001');
  assert.equal(thread.childName,'Вася Пробный');
});

test('foreign or expired thread cursor is rejected instead of replaying first page',async()=>{
  const sql={async begin(_options,run) {
    const tx=async strings=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.includes('FROM parent_profiles'))return [[{
        phone10:'9000000001',parent_name:'Test',child_id:'child-1',child_name:'Fake Child'
      }]];
      if(query.includes('FROM children'))return [[{
        registered_first_name:'Fake',surname:'Child'
      }]];
      if(query.includes('FROM chat_messages'))return [[]];
      throw new Error('Unexpected query: '+query);
    };
    return run(tx);
  }};
  await assert.rejects(
    ()=>createChatOperations(sql).thread('9000000001','foreign-message-key'),
    /Invalid or expired chat cursor/
  );
});
