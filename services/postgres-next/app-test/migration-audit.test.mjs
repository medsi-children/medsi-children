import test from 'node:test';
import assert from 'node:assert/strict';
import { generateManifest, compareManifests, REQUIRED_STREAMS } from '../app/migration-audit.mjs';

const secret = 'a-only-for-testing-32-byte-migration-key-change-it';
test('manifest hides record contents and ignores source order/property order', () => {
  const left = [{ phone: '9000000001', text: 'Тестовое сообщение' }, { phone: '9000000002', text: 'Вторая запись' }];
  const right = [{ text: 'Вторая запись', phone: '9000000002' }, { text: 'Тестовое сообщение', phone: '9000000001' }];
  const a = generateManifest('chat_messages', left, secret);
  const b = generateManifest('chat_messages', right, secret);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a).includes('9000000001'), false);
  assert.equal(JSON.stringify(a).includes('Тестовое'), false);
  assert.equal(compareManifests([a], [b], ['chat_messages']).ready, true);
});

test('manifest detects lost or altered rows even if counts match', () => {
  const original = generateManifest('chat_messages', [{ id:'one', text:'A' }, {id:'two',text:'B'}], secret);
  const changed = generateManifest('chat_messages', [{ id:'one', text:'A' }, {id:'two',text:'C'}], secret);
  const sameCount = compareManifests([original], [changed], ['chat_messages']);
  assert.equal(sameCount.findings[0].sourceCount, 2);
  assert.equal(sameCount.findings[0].destinationCount, 2);
  assert.equal(sameCount.ready, false);
});

test('all required streams must match; cannot silently skip passkeys or push', () => {
  const a = generateManifest('chat_messages', [], secret);
  const report = compareManifests([a], [a]);
  assert.equal(report.ready, false);
  assert.ok(report.findings.some(item => item.stream === 'passkeys' && item.status === 'missing'));
  assert.ok(REQUIRED_STREAMS.includes('push_subscriptions'));
});

test('manifest rejects weak keys and identifies duplicate normalized rows', () => {
  assert.throws(() => generateManifest('parents', [], 'weak'), /32 bytes/);
  assert.equal(generateManifest('parents', [{a:1}, {a:1}], secret).duplicateRows, 1);
});
