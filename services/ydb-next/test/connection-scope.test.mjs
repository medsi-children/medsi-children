import test from 'node:test';
import assert from 'node:assert/strict';
import {readConnectionConfig} from '../src/connection.mjs';

const env={
  MEDSI_NEXT_YDB_ENABLED:'1',MEDSI_NEXT_STAND:'1',
  YDB_CONNECTION_STRING:'grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/demo/db',
  YDB_SERVICE_ACCOUNT_JSON:JSON.stringify({
    id:'synthetic-key',service_account_id:'synthetic-service',
    private_key:'-----BEGIN PRIVATE KEY-----SYNTHETIC-ONLY'
  })
};
test('test stands cannot operate in database root or live YDB table scope',()=>{
  assert.throws(()=>readConnectionConfig(env),/explicit test table scope/);
  assert.throws(()=>readConnectionConfig({...env,MEDSI_NEXT_YDB_TABLE_SCOPE:'medsi_next_live'}),
    /explicit test table scope/);
  assert.throws(()=>readConnectionConfig({...env,MEDSI_NEXT_YDB_TABLE_SCOPE:'../live'}),
    /explicit test table scope/);
  assert.equal(readConnectionConfig({...env,MEDSI_NEXT_YDB_TABLE_SCOPE:'medsi_next_test'}).tableScope,
    'medsi_next_test');
});
