import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChatMessage, createChatStore } from '../src/chat-store.mjs';

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
        return activePhones.includes(params[0]) ? [[{ phone10: params[0] }]] : [[]];
      }
      if (q.includes('FROM chat_thread_state')) {
        const row=draft.threads.get(params[0]);
        return row ? [[row]] : [[]];
      }
      if (q.includes('FROM chat_messages')) {
        const row = draft.messages.get(params[0]+'/'+params[1]);
        return row && row.status === params[2] ? [[{ message_key: row.message_key }]] : [[]];
      }
      const kind = q.match(/^UPSERT INTO ([a-z_]+)/)?.[1];
      if (kind === 'chat_messages') {
        draft.messages.set(params[0]+'/'+params[1], {
          phone10: params[0], message_key: params[1], text: params[5], status: params[9]
        });
      } else if (kind === 'chat_message_dedup') {
        draft.dedup.set(params[0]+'/'+params[1], { message_key: params[2], payload_hash: params[3] });
      } else if (kind === 'chat_thread_state') {
        draft.threads.set(params[0], {last_message_key:params[1],last_at:Number(params[5].value||0),educator_has_unread:params[6],parent_has_unread:params[7]});
      } else if (kind === 'push_outbox') {
        draft.push.set(params[0], JSON.parse(params[3]));
      } else throw new Error('Unexpected query: '+q);
      return [[]];
    };
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

test('message creation is idempotent and notifications contain no message text', async () => {
  const { state, sql } = fakeSql();
  const store = createChatStore(sql);
  const first = await store.send(payload());
  assert.equal(first.status, 'created');
  assert.equal(state.messages.size, 1);
  assert.equal(state.dedup.size, 1);
  assert.equal(state.push.size, 1);
  const push = [...state.push.values()][0];
  assert.equal(push.body, 'Новое сообщение в чате.');
  assert.equal(JSON.stringify(push).includes('Сообщение для теста'), false);
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
