import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePgQuery, createPostgresSql, readPostgresConfig, normalizePgValue } from '../src/connection.mjs';

test('the compatibility compiler parameterizes values rather than interpolating text', () => {
  const input = "hello'; DROP TABLE children;--";
  const q = compilePgQuery(['SELECT phone10 FROM parent_profiles WHERE parent_name=', ''], [input]);
  assert.match(q.text, /parent_name=\$1/);
  assert.equal(q.values[0], input);
  assert.doesNotMatch(q.text, /DROP TABLE/);
});

test('PostgreSQL upsert helper emits a native conflict update', () => {
  const q = compilePgQuery(
    ['INSERT INTO chat_pins (phone10,bucket,updated_at) VALUES (', ',', ',', ')'],
    ['9990001112', 'pinned', 123], {upsert:true}
  );
  assert.match(q.text, /^INSERT INTO "chat_pins"/);
  assert.match(q.text, /ON CONFLICT \("phone10"\) DO UPDATE SET/);
  assert.deepEqual(q.values, ['9990001112', 'pinned', 123]);
});

test('queries use ordinary PostgreSQL table access without index hint syntax', () => {
  const q = compilePgQuery(
    ['SELECT phone10 FROM chat_messages WHERE file_id=', ''],
    ['s3:synthetic']
  );
  assert.match(q.text, /WHERE file_id=\$1/);
});

test('BigInt values become PostgreSQL BIGINT parameters', () => {
  assert.equal(normalizePgValue(123n), '123');
});

test('dynamic SQL identifiers must refer to existing schema tables', () => {
  const fake = { query: async () => ({ rows: [] }), connect: async () => ({}) };
  const sql = createPostgresSql(fake);
  assert.throws(() => sql.identifier('children; DROP TABLE parent_profiles'), /Unapproved/);
  const q = compilePgQuery(['DELETE FROM ', ' WHERE phone10=', ''], [
    sql.identifier('chat_messages'), '9990001112'
  ]);
  assert.match(q.text, /DELETE FROM "chat_messages" WHERE phone10=\$1/);
});

test('SQL transactions commit on success and roll back on failure', async () => {
  const actions = [];
  const client = {
    query: async q => {
      actions.push(typeof q === 'string' ? q : q.text);
      return { rows: [{ ok: 1 }] };
    },
    release: () => actions.push('RELEASE')
  };
  const sql = createPostgresSql({
    query: client.query,
    connect: async () => client
  });
  await sql.begin({ isolation: 'serializableReadWrite' }, async tx => {
    const [rows] = await tx(['SELECT 1']);
    assert.equal(rows[0].ok, 1);
  });
  assert.deepEqual(actions.slice(0, 4), [
    'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE', 'SELECT 1', 'COMMIT', 'RELEASE'
  ]);
  await assert.rejects(sql.begin({ isolation: 'snapshotReadOnly' }, async () => {
    throw new Error('deliberate test failure');
  }), /deliberate/);
  assert.ok(actions.includes('ROLLBACK'));
});

test('TLS certificate is mandatory outside an isolated local CI database', () => {
  const basic = {
    MEDSI_NEXT_PG_ENABLED: '1', MEDSI_NEXT_STAND: '1',
    PGHOST: 'db.example.invalid', PGDATABASE: 'medsi', PGUSER: 'app',
    PGPASSWORD: 'not-logged'
  };
  assert.throws(() => readPostgresConfig(basic), /trusted TLS CA/);
  const config = readPostgresConfig({
    ...basic, CI: 'true', NODE_ENV: 'test', PG_TEST_INSECURE_LOCAL: '1',
    PGHOST: '127.0.0.1'
  });
  assert.equal(config.ssl, false);
});
