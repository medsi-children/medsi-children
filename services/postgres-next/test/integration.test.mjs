import test from 'node:test';
import assert from 'node:assert/strict';
import { installSchema } from '../src/schema-cli.mjs';
import { connectPostgresNext } from '../src/connection.mjs';
import { createChatStore } from '../../ydb-next/src/chat-store.mjs';

const enabled = process.env.CI === 'true' && process.env.PG_TEST_INSECURE_LOCAL === '1';

test('real PostgreSQL: initialize, transact, and send/deduplicate synthetic messages', {
  skip: enabled ? false : 'Run against a disposable PostgreSQL CI service only.'
}, async () => {
  const env = { ...process.env, PG_SCHEMA_CONFIRM: 'CREATE_SCHEMA_IN_EMPTY_DATABASE' };
  const installed = await installSchema(env);
  assert.equal(installed.tables, 27);
  const connection = await connectPostgresNext(env);
  try {
    const { sql } = connection;
    await sql(
      ['INSERT INTO parent_profiles (phone10, parent_name, child_name) VALUES (', ',', ',', ')'],
      '9990001112', 'Test parent', 'Fictional child'
    );
    const store = createChatStore(sql);
    const input = {
      phone10: '9990001112', side: 'parent', type: 'text',
      text: 'Synthetic test only', clientMessageId: 'ci-message-0001'
    };
    const created = await store.send(input);
    assert.equal(created.status, 'created');
    const duplicate = await store.send(input);
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.messageKey, created.messageKey);
    const [messages] = await sql(['SELECT message_key, text FROM chat_messages WHERE phone10=', ''], '9990001112');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, 'Synthetic test only');
    const [push] = await sql(['SELECT status FROM push_outbox WHERE phone10=', ''], '9990001112');
    assert.equal(push[0].status, 'pending');
  } finally {
    await connection.driver.close();
  }
});
