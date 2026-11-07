import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatOperations,messageFromRow} from '../app/chat-operations.mjs';

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


function mutableChatFixture(lastKey='latest-001') {
  const state={
    phone10:'9000000001',
    last_message_key:lastKey,last_side:'educator',last_type:'text',
    last_text:'Старый предпросмотр',last_at:1700,educator_has_unread:false
  };
  const messages=new Map([
    ['latest-001',{phone10:state.phone10,message_key:'latest-001',
      side:'educator',type:'text',text:'Старый предпросмотр',status:'active'}],
    ['older-001',{phone10:state.phone10,message_key:'older-001',
      side:'educator',type:'text',text:'Прежний текст',status:'active'}]
  ]);
  const queries=[];
  const sql={async begin(options,run){
    const tx=async(strings,...values)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      queries.push(query);
      if(query.includes('SELECT phone10,message_key,side,type,text,reaction,status')&&query.includes('FROM chat_messages')) {
        return [[messages.get(values[0])||null]];
      }
      if(query.startsWith('UPDATE chat_messages SET text=')) {
        const row=messages.get(values[3]); // text, edited_at, phone, message key
        if(row&&row.phone10===values[2])row.text=values[0];
        return [[]];
      }
      if(query.startsWith('UPDATE chat_thread_state SET last_text=')) {
        if(state.phone10===values[1]&&state.last_message_key===values[2])state.last_text=values[0];
        return [[]];
      }
      if(query.includes('FROM chat_thread_state AS s')) {
        const last=messages.get(state.last_message_key);
        return [[{...state,last_text:last&&last.status==='active'?last.text:state.last_text}]];
      }
      if(query.includes('FROM chat_pins'))return [[]];
      if(query.includes('FROM parent_profiles'))return [[{
        phone10:state.phone10,parent_name:'Тестовый родитель',
        child_id:'child-001',child_name:'Ребёнок',relationship:'Мама'
      }]];
      if(query.includes('FROM children'))return [[{
        child_id:'child-001',registered_first_name:'Ребёнок',surname:'Тестовый'
      }]];
      throw new Error('Unexpected SQL query '+query);
    };
    return run(tx);
  }};
  return {sql,state,messages,queries};
}

test('editing latest chat message immediately updates its persisted list preview',async()=>{
  const {sql,state,queries}=mutableChatFixture();
  const ops=createChatOperations(sql);
  const updated=await ops.mutate('edit','latest-001',{role:'educator'},{text:'Исправленное сообщение'});
  assert.equal(updated.ok,true);
  assert.equal(state.last_text,'Исправленное сообщение');
  assert.equal((await ops.listChats()).chats[0].lastText,'Исправленное сообщение');
  assert.ok(queries.some(query=>query.includes('UPDATE chat_thread_state SET last_text=')&&
    query.includes('last_message_key=')));
});

test('editing an older message never replaces the latest preview',async()=>{
  const {sql,state,messages}=mutableChatFixture();
  const ops=createChatOperations(sql);
  await ops.mutate('edit','older-001',{role:'educator'},{text:'Изменено старое сообщение'});
  assert.equal(messages.get('older-001').text,'Изменено старое сообщение');
  assert.equal(state.last_text,'Старый предпросмотр');
  assert.equal((await ops.listChats()).chats[0].lastText,'Старый предпросмотр');
});

test('already edited historical messages are shown in preview without resending',async()=>{
  const {sql,state,messages,queries}=mutableChatFixture();
  // Simulate an edit made before this fix: chat_messages changed, state did not.
  messages.get('latest-001').text='Актуальный текст из сообщений';
  const chats=await createChatOperations(sql).listChats();
  assert.equal(state.last_text,'Старый предпросмотр');
  assert.equal(chats.chats[0].lastText,'Актуальный текст из сообщений');
  assert.ok(queries.some(query=>query.includes('COALESCE(m.text, s.last_text)')&&
    query.includes('m.message_key=s.last_message_key')));
});
