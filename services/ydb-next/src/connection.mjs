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
    // Some secret managers encode JSON a second time. Accept the equivalent
    // JSON string, but never guess at malformed plaintext or print its value.
    if (typeof serviceAccount === 'string') {
      serviceAccount = JSON.parse(serviceAccount);
    }
  } catch (_) {
    throw new Error('YDB_SERVICE_ACCOUNT_JSON is missing or invalid.');
  }
  // Yandex Cloud's downloaded authorized key can contain an official notice
  // BEFORE the PEM block:
  // "PLEASE DO NOT REMOVE THIS LINE! Yandex.Cloud SA Key ID <...>"
  // OpenSSL and the YDB credentials provider need the PEM block itself.
  // Accept only that exact optional preamble, bound to the same key ID.
  const originalPrivateKey=String(serviceAccount?.private_key||'').trim();
  const notice=/^PLEASE DO NOT REMOVE THIS LINE! Yandex\.Cloud SA Key ID <([A-Za-z0-9_-]+)>\r?\n/;
  const matched=notice.exec(originalPrivateKey);
  const normalizedPrivateKey=matched
    ?originalPrivateKey.slice(matched[0].length):originalPrivateKey;
  if (!serviceAccount || typeof serviceAccount!=='object' ||
      typeof serviceAccount.id!=='string' || !serviceAccount.id ||
      typeof serviceAccount.service_account_id!=='string' ||
      !serviceAccount.service_account_id ||
      (matched && matched[1]!==serviceAccount.id) ||
      !/^-----BEGIN PRIVATE KEY-----/.test(normalizedPrivateKey)) {
    throw new Error('YDB service account JSON lacks required authorized-key fields.');
  }
  const tableScope=String(env.MEDSI_NEXT_YDB_TABLE_SCOPE||'').trim();
  // Never allow an isolated stand, synthetic seed, or schema bootstrap to
  // touch database-root or live tables, including when sharing one YDB.
  if(env.MEDSI_NEXT_STAND==='1' && tableScope!=='medsi_next_test') {
    throw new Error('Isolated YDB operations require an explicit test table scope.');
  }
  if(tableScope)validateTableScope(tableScope,{stand:env.MEDSI_NEXT_STAND==='1'});
  return { connectionString, tableScope, serviceAccount: {
    id: serviceAccount.service_account_id,
    keyId: serviceAccount.id,
    privateKey: normalizedPrivateKey
  } };
}

export async function connectYdbNext(env = process.env) {
  const config = readConnectionConfig(env);
  const driver = new Driver(config.connectionString, {
    credentialsProvider: new ServiceAccountCredentialsProvider(config.serviceAccount)
  });
  let readyTimer;
  try {
    // A stalled SDK handshake must not hang the Timeweb rollout forever.
    // The bootstrap HTTP listener remains available for safe diagnostics.
    await Promise.race([
      driver.ready(),
      new Promise((_,reject)=>{
        readyTimer=setTimeout(()=>reject(new Error('YDB readiness deadline exceeded')),20000);
      })
    ]);
    const rawSql=query(driver);
    const sql=config.tableScope
      ?withTableScope(rawSql,config.tableScope,{stand:env.MEDSI_NEXT_STAND==='1'})
      :rawSql;
    return { sql, driver };
  } catch (error) {
    // Never print the connection string, credential object or patient data.
    if (typeof driver.destroy === 'function') {
      await Promise.race([
        driver.destroy().catch(()=>{}),
        new Promise(resolve=>setTimeout(resolve,3000))
      ]);
    }
    if(error?.message==='YDB readiness deadline exceeded'){
      throw new Error('YDB NEXT connection timed out.');
    }
    throw new Error('YDB NEXT connection failed.');
  } finally{
    if(readyTimer)clearTimeout(readyTimer);
  }
}
