import test from 'node:test';
import assert from 'node:assert/strict';
import { installSchema } from '../src/schema-cli.mjs';
import { connectPostgresNext } from '../src/connection.mjs';
import { createChatStore } from '../../ydb-next/src/chat-store.mjs';
import { createReportPublicationStore } from '../../ydb-next/src/report-publications.mjs';
import { createEducatorReportsDashboardStore } from '../../ydb-next/src/educator-report-dashboard.mjs';
import { seedSyntheticRoster } from '../../ydb-next/src/seed-demo.mjs';
import { importLegacyIdentityCapture } from '../../ydb-next/src/identity-continuity.mjs';
import { importLegacyPushCapture } from '../../ydb-next/src/push-continuity.mjs';
import { createECDH, createHash } from 'node:crypto';
import { createNextStandApp, createNextServices } from '../../ydb-next/src/stand-server.mjs';

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

test('real PostgreSQL: authenticated identity and push migration preserves opaque legacy values', {
  skip: enabled ? false : 'Disposable PostgreSQL CI only.'
}, async () => {
  const conn = await connectPostgresNext(process.env);
  try {
    const { sql } = conn;
    const [people] = await sql(['SELECT phone10 FROM parent_profiles']);
    assert.equal(people.length, 3);
    const capture = people.map((p, i) => ({
      phone10: p.phone10,
      user_handle: (String(i + 1).repeat(32)).slice(0, 32),
      generation_id: (String(i + 4).repeat(32)).slice(0, 32),
      created_at: 1700000000000 + i
    }));
    // Only within ephemeral CI: remove the seed fixture's mock identities.
    await sql(['DELETE FROM parent_auth_profiles']);
    const keyBytes = Buffer.alloc(64, 7);
    const keys = [{
      credential_id: 'synthetic_passkey_ci_key_1234567',
      user_handle: capture[0].user_handle,
      public_key_base64url: keyBytes.toString('base64url'),
      counter: 0,
      transports: ['internal'],
      device_type: 'synthetic',
      backed_up: true,
      created_at: 1700000000000
    }];
    await assert.rejects(importLegacyIdentityCapture(sql,
      { authProfiles: capture, passkeys: keys },
      { expectedProfiles: 3, expectedPasskeys: 1 }
    ), /explicit approval/);
    const imported = await importLegacyIdentityCapture(sql,
      { authProfiles: capture, passkeys: keys },
      { expectedProfiles: 3, expectedPasskeys: 1, freezeConfirmed: true, explicitImport: true }
    );
    assert.equal(imported.authProfiles, 3);
    assert.equal(imported.passkeys, 1);
    const [bytes] = await sql(['SELECT public_key FROM parent_passkeys']);
    assert.ok(Buffer.isBuffer(bytes[0].public_key));
    assert.deepEqual(bytes[0].public_key, keyBytes);

    const curve = createECDH('prime256v1');
    curve.generateKeys();
    const publicKey = curve.getPublicKey().toString('base64url');
    const privateKey = curve.getPrivateKey().toString('base64url');
    const endpoint = 'https://push.example.invalid/fictional-ci-endpoint';
    const digest = createHash('sha256').update(endpoint).digest('hex');
    const pushCapture = [{
      key: 'sub:' + digest,
      value: {
        role: 'parent', phone10: capture[0].phone10, enabled: true,
        updatedAt: '2026-11-04T10:00:00.000Z',
        subscription: { endpoint, keys: { auth: 'synthetic-auth', p256dh: 'synthetic-p256dh' } }
      }
    }];
    const opts = {
      sourceVapidPublicKey: publicKey, targetVapidPublicKey: publicKey,
      targetVapidPrivateKey: privateKey, expectedCount: 1,
      freezeConfirmed: true, explicitImport: true
    };
    const migrated = await importLegacyPushCapture(sql, pushCapture, opts);
    assert.equal(migrated.enabled, 1);
    const [subscribed] = await sql(['SELECT subscription_id,enabled FROM push_subscriptions']);
    assert.equal(subscribed.length, 1);
    assert.equal(subscribed[0].enabled, true);
  } finally {
    await conn.driver.close();
  }
});

test('real PostgreSQL HTTP: complete NEXT UI, protected endpoints and schema health', {
  skip: enabled ? false : 'Disposable PostgreSQL CI only.'
}, async () => {
  const conn = await connectPostgresNext(process.env);
  const env = {
    ...process.env, MEDSI_NEXT_STAND: '1', MEDSI_NEXT_PG_ENABLED: '1',
    NEXT_SESSION_SECRET: 'synthetic-ci-session-secret-1234567890',
    NEXT_TUTOR_LOGIN: 'fictional_ci_tutor',
    NEXT_TUTOR_PASSWORD: 'not-a-production-password',
    NEXT_TUTOR_VERSION: 'ci-1'
  };
  const services = createNextServices({ sql: conn.sql, env });
  const app = createNextStandApp(services, { env });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const health = await fetch(base + '/__health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).database, 'reachable');
    const schema = await fetch(base + '/__schema-health');
    assert.equal(schema.status, 200);
    assert.equal((await schema.json()).schema, 'reachable');
    for (const path of ['/', '/tutors', '/psychology']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') || '', /html/);
    }
    const protectedPage = await fetch(base + '/lab/admin/reports/dashboard');
    assert.equal(protectedPage.status, 401);
    const reportBody = await protectedPage.text();
    assert.doesNotMatch(reportBody, /Фантазийный отчёт|Тестовая|Проверочный/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await conn.driver.close();
  }
});
