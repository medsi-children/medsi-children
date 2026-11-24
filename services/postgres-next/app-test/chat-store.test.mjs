import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChatMessage, createChatStore } from '../app/chat-store.mjs';
import {createChatGallery} from '../app/chat-gallery.mjs';

const payload = (more={}) => ({
  phone10: '9000000001', side: 'parent', type: 'text',
  text: 'Сообщение для теста', clientMessageId: 'client_001',
  ...more
});

function fakeSql(activePhones = ['9000000001']) {
  const state = { messages: new Map(), dedup: new Map(), push: new Map(), threads: new Map() };
  const sql = { async begin(options, callback) {
    assert.equal(options.isolation, 'serializableReadWrite');
    const draft = {
      messages: new Map(state.messages),
      dedup: new Map(state.dedup),
      push: new Map(state.push),
      threads: new Map(state.threads)
    };
    const tx = async (strings, ...params) => {
      const q = strings.join(' ? ').replace(/\s+/g, ' ').trim();
      if (q.includes('FROM chat_message_dedup')) {
        const row = draft.dedup.get(params[0]+'/'+params[1]);
        return row ? [[row]] : [[]];
      }
      if (q.includes('FROM parent_profiles')) {
        return activePhones.includes(params[0]) ? [[{phone10:params[0],child_id:'synthetic-child-001',child_name:'Имя из профиля'}]] : [[]];
      }
      if (q.includes('FROM children'))return [[{registered_first_name:'Арина',surname:'Халитова'}]];
      if (q.includes('FROM chat_thread_state')) {
        const row=draft.threads.get(params[0]);
        return row ? [[row]] : [[]];
      }
      if (q.includes('FROM chat_media'))return [[{phone10:'9000000001'}]];
      if (q.includes('FROM chat_messages')) {
        const row = draft.messages.get(params[0]+'/'+params[1]);
        return row && row.status === params[2] ? [[{ message_key: row.message_key }]] : [[]];
      }
      const kind = q.match(/^INSERT INTO ([a-z_]+)/)?.[1];
      if (kind === 'chat_messages') {
        draft.messages.set(params[0]+'/'+params[1], {
          phone10: params[0], message_key: params[1], text: params[5], status: params[9]
        });
      } else if (kind === 'chat_message_dedup') {
        draft.dedup.set(params[0]+'/'+params[1], { message_key: params[2], payload_hash: params[3] });
      } else if (kind === 'chat_thread_state') {
        draft.threads.set(params[0], {last_message_key:params[1],last_at:Number(params[5]),educator_has_unread:params[6],parent_has_unread:params[7]});
      } else if (kind === 'push_outbox') {
        draft.push.set(params[0], JSON.parse(params[3]));
      } else throw new Error('Unexpected query: '+q);
      return [[]];
    };
    tx.upsert=tx;
    const result = await callback(tx);
    Object.assign(state, draft);
    return result;
  }};
  return { state, sql };
}

test('new messages accept text and S3 media but reject invalid media sources', () => {
  assert.equal(prepareChatMessage(payload()).type, 'text');
  assert.equal(prepareChatMessage(payload({
    type:'image',text:'',fileId:'s3:media-object',clientMessageId:'client_002'
  })).type, 'image');
  assert.throws(() => prepareChatMessage(payload({type:'image',fileId:'kv:old-file'})), /Timeweb S3/);
  assert.throws(() => prepareChatMessage(payload({side:'other'})), /sender/);
  assert.throws(() => prepareChatMessage(payload({phone10:'900000000'})), /recipient/);
});

test('message creation is idempotent and notification previews use child name and message text', async () => {
  const { state, sql } = fakeSql();
  const store = createChatStore(sql);
  const first = await store.send(payload());
  assert.equal(first.status, 'created');
  assert.equal(state.messages.size, 1);
  assert.equal(state.dedup.size, 1);
  assert.equal(state.push.size, 1);
  const push = [...state.push.values()][0];
  assert.equal(push.title,'Арина Халитова');
  assert.equal(push.body,'Сообщение для теста');
  assert.equal(push.type,'chat');
  assert.match(push.threadTag,/^medsi-chat-[a-f0-9]{20}$/);
  assert.equal(push.messageAt,first.timestamp);
  assert.equal(push._chatMessageKey,first.messageKey);
  assert.equal(push._chatSide,'parent');
  assert.ok(!JSON.stringify(push).includes('9000000001'),
    'Phone number must not appear in device-visible ordering metadata');
  const second = await store.send(payload());
  assert.equal(second.status, 'duplicate');
  assert.equal(second.messageKey, first.messageKey);
  assert.equal(state.messages.size, 1);
  assert.equal(state.push.size, 1);
  await assert.rejects(() => store.send(payload({text:'Другое содержание'})), /reused/);
});

test('inactive profile or foreign reply cannot result in a saved message', async () => {
  const {state,sql} = fakeSql();
  const store = createChatStore(sql);
  await assert.rejects(() => store.send(payload({phone10:'9000000099'})), /closed/);
  await assert.rejects(() => store.send(payload({replyToKey:'foreign_message'})), /Reply target/);
  assert.equal(state.messages.size, 0);
  assert.equal(state.push.size, 0);
});

test('outgoing educator and media pushes show department name and a compact preview',async()=>{
  const {state,sql}=fakeSql();
  const store=createChatStore(sql);
  await store.send(payload({side:'educator',text:'Добрый день!    Сообщение от воспитателей.',
    clientMessageId:'synthetic_staff_001'}));
  const notice=[...state.push.values()][0];
  assert.equal(notice.title,'Детское Отделение Медси');
  assert.equal(notice.body,'Добрый день! Сообщение от воспитателей.');
  await store.send(payload({side:'parent',type:'image',text:'Подпись',
    fileId:'s3:synthetic-media',clientMessageId:'synthetic_media_001'}));
  const latest=[...state.push.values()][1];
  assert.equal(latest.title,'Арина Халитова');
  assert.equal(latest.body,'📷 Фото · Подпись');
});

test('ten separately uploaded attachments form one stored chat message and one push',async()=>{
  const {state,sql}=fakeSql(),store=createChatStore(sql);
  const items=Array.from({length:10},(_,i)=>({
    fileId:'s3:chat/'+String(i+1).repeat(64)+'.jpg',type:i===4?'video':'image'
  }));
  const fileId=createChatGallery(items);
  const sent=await store.send(payload({type:'gallery',text:'',fileId,
    clientMessageId:'synthetic_gallery_send_001'}));
  assert.equal(sent.status,'created');
  assert.equal(state.messages.size,1);
  assert.equal(state.push.size,1);
  const notification=[...state.push.values()][0];
  assert.equal(notification.title,'Арина Халитова');
  assert.equal(notification.body,'📎 10 вложений');
  const again=await store.send(payload({type:'gallery',text:'',fileId,
    clientMessageId:'synthetic_gallery_send_001'}));
  assert.equal(again.status,'duplicate');
  assert.equal(state.messages.size,1);assert.equal(state.push.size,1);
});
test('gallery cannot reference an arbitrary or malformed S3 object',()=>{
  const one='s3:chat/'+ 'a'.repeat(64)+'.jpg';
  assert.throws(()=>prepareChatMessage(payload({type:'gallery',
    fileId:'gallery:'+JSON.stringify([{fileId:one,type:'image'}])})),/2 to 10/);
});

test('disabled push never builds a chat notification backlog',async()=>{
  const {sql,state}=fakeSql();
  const store=createChatStore(sql,{queuePush:false});
  const sent=await store.send(payload({clientMessageId:'synthetic_push_off_001'}));
  assert.equal(sent.status,'created');
  assert.equal(state.messages.size,1);
  assert.equal(state.push.size,0);
  assert.equal(state.threads.size,1);
  const same=await store.send(payload({clientMessageId:'synthetic_push_off_001'}));
  assert.equal(same.status,'duplicate');
  assert.equal(state.push.size,0);
});

test('consecutive messages keep distinct exact previews but one stable conversation tag',async()=>{
  const {state,sql}=fakeSql();
  const chat=createChatStore(sql);
  const first=await chat.send(payload({clientMessageId:'synthetic_push_seq_01',text:'Первое синтетическое сообщение.'}));
  const second=await chat.send(payload({clientMessageId:'synthetic_push_seq_02',text:'Второе синтетическое сообщение.'}));
  const p1=state.push.get('chat_'+(await import('node:crypto')).createHash('sha256')
    .update('9000000001\u0000synthetic_push_seq_01','utf8').digest('hex'));
  const p2=state.push.get('chat_'+(await import('node:crypto')).createHash('sha256')
    .update('9000000001\u0000synthetic_push_seq_02','utf8').digest('hex'));
  assert.ok(p1&&p2);
  assert.equal(p1.body,'Первое синтетическое сообщение.');
  assert.equal(p2.body,'Второе синтетическое сообщение.');
  assert.equal(p1.threadTag,p2.threadTag);
  assert.equal(p1._chatMessageKey,first.messageKey);
  assert.equal(p2._chatMessageKey,second.messageKey);
});
