import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBootstrapEnabled,assertStandRuntime} from '../../../scripts/prepare-ydb-test.mjs';

const valid={
  MEDSI_NEXT_PREPARE_YDB_TEST:'YES',
  MEDSI_NEXT_STAND:'1',
  MEDSI_NEXT_YDB_ENABLED:'1',
  MEDSI_NEXT_YDB_TABLE_SCOPE:'medsi_next_test'
};

test('bootstrap requires explicit isolated test settings',()=>{
  assert.doesNotThrow(()=>assertBootstrapEnabled(valid));
  for(const key of Object.keys(valid)){
    const invalid={...valid,[key]:key==='MEDSI_NEXT_YDB_TABLE_SCOPE'?'medsi_next_live':'0'};
    assert.throws(()=>assertBootstrapEnabled(invalid));
  }
});

test('bootstrap refuses to enable deletion on the unverified stand',()=>{
  assert.throws(()=>assertBootstrapEnabled({...valid,MEDSI_NEXT_DELETION_ENABLED:'1'}));
});

test('prepared stand runtime does not need the one-time preparation flag',()=>{
  const {MEDSI_NEXT_PREPARE_YDB_TEST,...runtime}=valid;
  assert.doesNotThrow(()=>assertStandRuntime(runtime));
  assert.throws(()=>assertStandRuntime({...runtime,MEDSI_NEXT_YDB_TABLE_SCOPE:'medsi_next_live'}));
});
