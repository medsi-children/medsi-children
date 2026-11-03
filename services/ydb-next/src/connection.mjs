import { Driver } from '@ydbjs/core';
import { query } from '@ydbjs/query';
import { ServiceAccountCredentialsProvider } from '@ydbjs/auth-yandex-cloud';
import {withTableScope,validateTableScope} from './table-scope.mjs';

// This package is deliberately NOT imported by production server.js.
// Explicit opt-in and fail-closed auth prevent accidental access to patient data.
export function readConnectionConfig(env = process.env) {
  if (env.MEDSI_NEXT_YDB_ENABLED !== '1') {
    throw new Error('YDB NEXT is disabled; explicit test-only opt-in is required.');
  }
  const connectionString = String(env.YDB_CONNECTION_STRING || '');
  if (!/^grpcs:\/\/ydb\.serverless\.yandexcloud\.net:2135\/\?database=\/ru-central1\//.test(connectionString)) {
    throw new Error('YDB NEXT requires an encrypted Yandex YDB Serverless endpoint.');
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(String(env.YDB_SERVICE_ACCOUNT_JSON || ''));
  } catch (_) {
    throw new Error('YDB_SERVICE_ACCOUNT_JSON is missing or invalid.');
  }
  if (!serviceAccount || !serviceAccount.id || !serviceAccount.service_account_id ||
      !/^-----BEGIN PRIVATE KEY-----/.test(String(serviceAccount.private_key || ''))) {
    throw new Error('YDB service account JSON lacks required authorized-key fields.');
  }
  const tableScope=String(env.MEDSI_NEXT_YDB_TABLE_SCOPE||'').trim();
  if(tableScope)validateTableScope(tableScope,{stand:env.MEDSI_NEXT_STAND==='1'});
  return { connectionString, tableScope, serviceAccount: {
    id: serviceAccount.service_account_id,
    keyId: serviceAccount.id,
    privateKey: serviceAccount.private_key
  } };
}

export async function connectYdbNext(env = process.env) {
  const config = readConnectionConfig(env);
  const driver = new Driver(config.connectionString, {
    credentialsProvider: new ServiceAccountCredentialsProvider(config.serviceAccount)
  });
  try {
    await driver.ready();
    const rawSql=query(driver);
    const sql=config.tableScope
      ?withTableScope(rawSql,config.tableScope,{stand:env.MEDSI_NEXT_STAND==='1'})
      :rawSql;
    return { sql, driver };
  } catch (error) {
    // Never print the connection string, the credential object or YDB payloads.
    if (typeof driver.destroy === 'function') await driver.destroy().catch(() => {});
    throw new Error('YDB NEXT connection failed.', { cause: error });
  }
}
