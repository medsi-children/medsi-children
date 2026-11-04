import test from 'node:test';
import assert from 'node:assert/strict';
import { installSchema } from '../src/schema-cli.mjs';
import { connectPostgresNext } from '../src/connection.mjs';
import { createChatStore } from '../../ydb-next/src/chat-store.mjs';
import { createReportPublicationStore } from '../../ydb-next/src/report-publications.mjs';
import { createEducatorReportsDashboardStore } from '../../ydb-next/src/educator-report-dashboard.mjs';
import { seedSyntheticRoster } from '../../ydb-next/src/seed-demo.mjs';

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

test('real PostgreSQL: synthetic roster, safeguarded report publication, dashboard and idempotency', {
  skip: enabled ? false : 'Disposable PostgreSQL CI only.'
}, async () => {
  const conn = await connectPostgresNext(process.env);
  try {
    const { sql } = conn;
    // The previous smoke test seeded one fictional parent. Clear only known
    // synthetic records in the disposable CI database, never a real database.
    const [before] = await sql(['SELECT phone10 FROM parent_profiles']);
    assert.deepEqual(before.map(x => x.phone10), ['9990001112']);
    await sql(['DELETE FROM push_outbox']);
    await sql(['DELETE FROM chat_message_dedup']);
    await sql(['DELETE FROM chat_messages']);
    await sql(['DELETE FROM chat_thread_state']);
    await sql(['DELETE FROM parent_profiles']);
    const seeded = await seedSyntheticRoster({sql});
    assert.equal(seeded.parents, 3);
    const seededAgain = await seedSyntheticRoster({sql});
    assert.equal(seededAgain.alreadySeeded, true);

    const [profiles] = await sql(['SELECT phone10,admission_id FROM parent_profiles']);
    assert.equal(profiles.length, 3);
    const recipients = profiles.map(p => ({
      phone10: p.phone10, admissionId: p.admission_id,
      text: p.phone10 === '9000000003' ? 'Фантазийный отчёт Б' : 'Фантазийный отчёт А'
    }));
    const publisher = createReportPublicationStore(sql);
    const payload = {
      kind: 'morning', submissionId: 'ci_report_12345678',
      authorId: 'educator_ci_12345678',
      submittedAt: Date.now(),
      rawText: 'Вымышленные тестовые данные', normalizedText: 'Вымышленные тестовые данные',
      recipients, ownerReads: {}, ownerWrites: {}
    };
    const published = await publisher.publishPrepared(payload);
    assert.equal(published.status, 'published');
    assert.equal(published.recipients, 3);
    const duplicate = await publisher.publishPrepared(payload);
    assert.equal(duplicate.status, 'duplicate');

    const [latest] = await sql(['SELECT phone10,kind,text FROM parent_current_reports']);
    assert.equal(latest.length, 3);
    assert.equal(latest.find(x => x.phone10 === '9000000003').text, 'Фантазийный отчёт Б');
    const dashboard = await createEducatorReportsDashboardStore(sql).readForEducator();
    assert.equal(dashboard.children.length, 2);
    assert.equal(dashboard.raw.morning.rawText, payload.rawText);
    const [outbox] = await sql(['SELECT event_id FROM push_outbox']);
    assert.equal(outbox.length, 3);

    await assert.rejects(
      publisher.publishPrepared({...payload, submissionId: 'ci_report_87654321', recipients: recipients.slice(0, 2)}),
      /Parent roster changed/
    );
    const [remaining] = await sql(['SELECT publication_id FROM raw_reports']);
    assert.equal(remaining.length, 1);
  } finally {
    await conn.driver.close();
  }
});
