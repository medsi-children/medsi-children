import test from 'node:test';
import assert from 'node:assert/strict';
import {withTableScope,validateTableScope} from '../src/table-scope.mjs';

const fake=()=>{
  const calls=[];
  function sql(strings,...values) {
    const result={text:strings.join('?'),raw:strings.raw?.join('?'),
      values};
    calls.push(result);
    return result;
  }
  sql.identifier=value=>({identifier:value});
  sql.unsafe=value=>({unsafe:value});
  sql.begin=async(options,fn)=>{
    assert.equal(options.isolation,'serializableReadWrite');
    return fn(sql);
  };
  return {sql,calls};
};
test('one YDB uses separate prefixed YQL for test tables in and outside transactions',async()=>{
  const f=fake();
  const scoped=withTableScope(f.sql,'medsi_next_test',{stand:true});
  const top=scoped`SELECT 1 AS connected`;
  assert.match(top.text,/^PRAGMA TablePathPrefix = "medsi_next_test";/);
  assert.match(top.text,/SELECT 1 AS connected/);
  const result=await scoped.begin({isolation:'serializableReadWrite'},
    async tx=>tx`SELECT phone10 FROM parent_profiles WHERE phone10=${'9000000001'}`);
  assert.match(result.text,/^PRAGMA TablePathPrefix = "medsi_next_test";/);
  assert.deepEqual(result.values,['9000000001']);
  assert.deepEqual(scoped.identifier('profiles'),{identifier:'profiles'});
  assert.deepEqual(scoped.unsafe('SELECT 1'),{unsafe:'SELECT 1'});
});
test('unsafe scopes and production table prefix are blocked on isolated stands',()=>{
  for(const scope of ['../live','medsi_next_test/../live','other','']) {
    assert.throws(()=>validateTableScope(scope),/Unrecognized/);
  }
  assert.throws(()=>validateTableScope('medsi_next_live',{stand:true}),/only use YDB test/);
  assert.equal(validateTableScope('medsi_next_live'), 'medsi_next_live');
});
