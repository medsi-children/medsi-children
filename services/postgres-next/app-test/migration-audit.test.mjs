import test from 'node:test';
import assert from 'node:assert/strict';
import { generateManifest, compareManifests, REQUIRED_STREAMS,
  signManifestEnvelope, verifyManifestEnvelope } from '../app/migration-audit.mjs';

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

test('all required data streams must match; cannot silently skip auth, chat, reports or media', () => {
  const a = generateManifest('chat_messages', [], secret);
  const report = compareManifests([a], [a]);
  assert.equal(report.ready, false);
  assert.ok(report.findings.some(item => item.stream === 'parent_passkeys' && item.status === 'missing'));
  assert.ok(REQUIRED_STREAMS.includes('push_subscriptions'));
  assert.ok(REQUIRED_STREAMS.includes('parent_report_history'));
  assert.ok(REQUIRED_STREAMS.includes('chat_media'));
  assert.ok(REQUIRED_STREAMS.includes('s3_objects'));
  assert.equal(REQUIRED_STREAMS.length, 26);
});

test('migration envelope signature authenticates the capture ID and every stream manifest', () => {
  const manifests = REQUIRED_STREAMS.map(stream => generateManifest(stream, [], secret));
  const envelope = signManifestEnvelope('frozen_capture_20261104', manifests, secret);
  assert.equal(verifyManifestEnvelope(envelope, secret), true);
  assert.equal(verifyManifestEnvelope(envelope, 'another-secret-value-that-is-long-enough'), false);
  assert.equal(verifyManifestEnvelope({...envelope, captureId:'other_capture_20261104'}, secret), false);
  const altered = {...envelope, manifests:envelope.manifests.map((item,index)=>
    index===0?{...item,count:item.count+1}:item)};
  assert.equal(verifyManifestEnvelope(altered, secret), false);
});

test('manifest rejects weak keys and identifies duplicate normalized rows', () => {
  assert.throws(() => generateManifest('parents', [], 'weak'), /32 bytes/);
  assert.equal(generateManifest('parents', [{a:1}, {a:1}], secret).duplicateRows, 1);
});
