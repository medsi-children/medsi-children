import test from 'node:test';
import assert from 'node:assert/strict';
import {generateManifest,REQUIRED_STREAMS,signManifestEnvelope} from '../app/migration-audit.mjs';
import {evaluateMigrationGate} from '../app/migration-gate.mjs';

const secret='m'.repeat(64);
const envelope=(key,mutate=()=>{})=>signManifestEnvelope('frozen_20261103_001',
  REQUIRED_STREAMS.map((stream,index)=>{
    const rows=[{id:stream+'-item-'+key}];
    mutate(rows,stream,index);
    return generateManifest(stream,rows,secret);
  }),secret);
const gate=(source,destination)=>evaluateMigrationGate(source,destination,{hmacKey:secret});
test('matching manifests from the same frozen capture permit cutover audit',()=>{
  const source=envelope('same'),destination=envelope('same');
  const result=gate(source,destination);
  assert.equal(result.ready,true);
  assert.equal(result.matched,REQUIRED_STREAMS.length);
});
test('different frozen captures cannot pass audit even when rows are identical',()=>{
  const source=envelope('same'),destination=signManifestEnvelope('other_frozen_20261103',
    source.manifests,secret);
  const result=gate(source,destination);
  assert.equal(result.ready,false);
  assert.equal(result.reason,'CAPTURE_WINDOW_MISMATCH');
});
test('missing, duplicated, and changed streams block migration',()=>{
  const source=envelope('same'),dest=envelope('same');
  dest.manifests.pop();
  assert.equal(gate(source,dest).ready,false);
  dest.manifests.push({...dest.manifests[0]});
  assert.throws(()=>gate(source,dest),/duplicate/);
  const changed=envelope('altered');
  assert.equal(gate(source,changed).ready,false);
});
test('a wrong row total, duplicate count or malformed digest blocks migration',()=>{
  const source=envelope('same'),dest=envelope('same');
  dest.manifests[0].count++;
  assert.equal(gate(source,dest).ready,false);
  dest.manifests[0].count--;
  dest.manifests[0].duplicateRows=1;
  assert.equal(gate(source,dest).ready,false);
  dest.manifests[0].digest='not-a-valid-hmac';
  assert.throws(()=>gate(source,dest),/Malformed/);
});
test('missing audit key, bad envelope signature, or missing stream fails closed',()=>{
  const source=envelope('same'),destination=envelope('same');
  assert.equal(evaluateMigrationGate(source,destination).reason,'MANIFEST_SIGNATURE_INVALID');
  const forged={...source,signature:'0'.repeat(64)};
  assert.equal(gate(forged,destination).reason,'MANIFEST_SIGNATURE_INVALID');
  const incomplete=envelope('same');
  incomplete.manifests.pop();
  const correctlySignedButIncomplete=signManifestEnvelope(incomplete.captureId,
    incomplete.manifests,secret);
  assert.equal(gate(correctlySignedButIncomplete,destination).reason,'STREAM_MISMATCH');
});
