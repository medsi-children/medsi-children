import test from 'node:test';
import assert from 'node:assert/strict';
import {generateManifest,REQUIRED_STREAMS} from '../src/migration-audit.mjs';
import {evaluateMigrationGate} from '../src/migration-gate.mjs';

const secret='m'.repeat(64);
const envelope=(key,mutate=()=>{})=>({
  captureId:'frozen_20261103_001',
  manifests:REQUIRED_STREAMS.map((stream,index)=>{
    const rows=[{id:stream+'-item-'+key}];
    mutate(rows,stream,index);
    return generateManifest(stream,rows,secret);
  })
});
test('matching manifests from the same frozen capture permit cutover audit',()=>{
  const source=envelope('same'),destination=envelope('same');
  const result=evaluateMigrationGate(source,destination);
  assert.equal(result.ready,true);
  assert.equal(result.matched,REQUIRED_STREAMS.length);
});
test('different frozen captures cannot pass audit even when rows are identical',()=>{
  const source=envelope('same'),destination=envelope('same');
  destination.captureId='other_frozen_20261103';
  const result=evaluateMigrationGate(source,destination);
  assert.equal(result.ready,false);
  assert.equal(result.reason,'CAPTURE_WINDOW_MISMATCH');
});
test('missing, duplicated, and changed streams block migration',()=>{
  const source=envelope('same'),dest=envelope('same');
  dest.manifests.pop();
  assert.equal(evaluateMigrationGate(source,dest).ready,false);
  dest.manifests.push({...dest.manifests[0]});
  assert.throws(()=>evaluateMigrationGate(source,dest),/duplicate/);
  const changed=envelope('altered');
  assert.equal(evaluateMigrationGate(source,changed).ready,false);
});
test('a wrong row total, duplicate count or malformed digest blocks migration',()=>{
  const source=envelope('same'),dest=envelope('same');
  dest.manifests[0].count++;
  assert.equal(evaluateMigrationGate(source,dest).ready,false);
  dest.manifests[0].count--;
  dest.manifests[0].duplicateRows=1;
  assert.equal(evaluateMigrationGate(source,dest).ready,false);
  dest.manifests[0].digest='not-a-valid-hmac';
  assert.throws(()=>evaluateMigrationGate(source,dest),/Malformed/);
});
