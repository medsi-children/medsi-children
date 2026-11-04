import test from 'node:test';
import assert from 'node:assert/strict';
import {readConnectionConfig} from '../src/connection.mjs';
import {ServiceAccountCredentialsProvider} from '@ydbjs/auth-yandex-cloud';

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

test('Yandex downloaded authorized key notice is stripped before handing PEM to SDK',()=>{
  const notice='PLEASE DO NOT REMOVE THIS LINE! Yandex.Cloud SA Key ID <synthetic-key>\n';
  const pem='-----BEGIN PRIVATE KEY-----\nSYNTHETIC-FAKE-KEY\n-----END PRIVATE KEY-----\n';
  const sample={id:'synthetic-key',service_account_id:'synthetic-service',
    private_key:notice+pem};
  const scoped={...env,MEDSI_NEXT_YDB_TABLE_SCOPE:'medsi_next_test',
    YDB_SERVICE_ACCOUNT_JSON:JSON.stringify(sample)};
  const result=readConnectionConfig(scoped);
  assert.deepEqual(result.serviceAccount,{
    id:'synthetic-key',
    service_account_id:'synthetic-service',
    private_key:pem.trim()
  });
  // Regression: the exact v0.2.0 SDK constructor used to reject our old
  // id/keyId/privateKey adapter object in the isolated Timeweb stand.
  assert.doesNotThrow(()=>new ServiceAccountCredentialsProvider({...result.serviceAccount}));
  assert.throws(()=>new ServiceAccountCredentialsProvider({
    id:'synthetic-service',keyId:'synthetic-key',privateKey:pem.trim()
  }),/missing required fields/);
  assert.equal(result.tableScope,'medsi_next_test');
  // A secret manager may encode a JSON string a second time.
  assert.equal(readConnectionConfig({...scoped,
    YDB_SERVICE_ACCOUNT_JSON:JSON.stringify(scoped.YDB_SERVICE_ACCOUNT_JSON)})
    .serviceAccount.private_key,pem.trim());
});

test('unknown notices, incorrect key IDs and invalid JSON fail closed',()=>{
  const pem='-----BEGIN PRIVATE KEY-----\nSYNTHETIC-FAKE-KEY';
  const sample={id:'synthetic-key',service_account_id:'synthetic-service',
    private_key:'PLEASE DO NOT REMOVE THIS LINE! Yandex.Cloud SA Key ID <other-key>\n'+pem};
  const scoped={...env,MEDSI_NEXT_YDB_TABLE_SCOPE:'medsi_next_test'};
  assert.throws(()=>readConnectionConfig({...scoped,
    YDB_SERVICE_ACCOUNT_JSON:JSON.stringify(sample)}),/authorized-key fields/);
  sample.private_key='SURPRISE HEADER\n'+pem;
  assert.throws(()=>readConnectionConfig({...scoped,
    YDB_SERVICE_ACCOUNT_JSON:JSON.stringify(sample)}),/authorized-key fields/);
  assert.throws(()=>readConnectionConfig({...scoped,
    YDB_SERVICE_ACCOUNT_JSON:'"unparseable{'}),/missing or invalid/);
});
