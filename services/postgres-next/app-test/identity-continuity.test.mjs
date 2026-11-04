import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareLegacyIdentityCapture,importLegacyIdentityCapture}
  from '../app/identity-continuity.mjs';

const handle='a'.repeat(64), generation='b'.repeat(32);
const fakePublicKey=Buffer.alloc(80,3).toString('base64url');
const base=()=>({
  authProfiles:[{phone10:'9000000001',user_handle:handle,
    generation_id:generation,created_at:0}],
  passkeys:[{credential_id:'credential-test-000001',user_handle:handle,
    public_key_base64url:fakePublicKey,counter:17,transports:'["internal"]',
    device_type:'singleDevice',backed_up:1,created_at:100,revoked_at:null}]
});
const args={expectedProfiles:1,expectedPasskeys:1};
test('preserve old generations, auth creation timestamp, public keys and counters exactly',()=>{
  const prepared=prepareLegacyIdentityCapture(base(),args);
  assert.equal(prepared.profiles[0].generationId,generation);
  assert.equal(prepared.profiles[0].createdAt,0);
  assert.equal(prepared.keys[0].counter,17);
  assert.equal(Buffer.from(prepared.keys[0].publicKey).toString('base64url'),fakePublicKey);
  assert.equal(prepared.keys[0].revokedAt,0);
  assert.equal(prepared.keys[0].backedUp,true);
});
test('incomplete, duplicate and orphaned credential captures fail closed',()=>{
  const a=base();
  assert.throws(()=>prepareLegacyIdentityCapture(a,{expectedProfiles:2,expectedPasskeys:1}),/Incomplete/);
  const duplicate=base();duplicate.authProfiles.push({...duplicate.authProfiles[0]});
  assert.throws(()=>prepareLegacyIdentityCapture(duplicate,
    {expectedProfiles:2,expectedPasskeys:1}),/Duplicate/);
  const orphan=base();orphan.passkeys[0].user_handle='c'.repeat(64);
  assert.throws(()=>prepareLegacyIdentityCapture(orphan,args),/orphaned/);
  const corrupt=base();corrupt.passkeys[0].public_key_base64url='A*NOT-BASE64';
  assert.throws(()=>prepareLegacyIdentityCapture(corrupt,args),/public key|orphaned/);
});
function fakeSql({existing=false,parentPhones=['9000000001']}={}) {
  const writes=[];
  const sql={async begin(opts,callback){
    assert.equal(opts.isolation,'serializableReadWrite');
    const tx=async (strings,...values)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.startsWith('SELECT phone10 FROM parent_auth_profiles'))
        return [existing?[{phone10:'9000000001'}]:[]];
      if(query.startsWith('SELECT credential_id FROM parent_passkeys'))
        return [[]];
      if(query.startsWith('SELECT phone10 FROM parent_profiles'))
        return [parentPhones.map(phone10=>({phone10}))];
      if(query.startsWith('INSERT INTO ')){writes.push({query,values});return [];}
      throw new Error('Unexpected synthetic SQL '+query);
    };
    tx.upsert=tx;
    return callback(tx);
  }};
  return {sql,writes};
}
test('identity import is blocked until approved, with full parent roster preflight',async()=>{
  const f=fakeSql();
  await assert.rejects(()=>importLegacyIdentityCapture(f.sql,base(),args),/explicit approval/);
  assert.equal(f.writes.length,0);
  const flags={...args,freezeConfirmed:true,explicitImport:true};
  await assert.rejects(()=>importLegacyIdentityCapture(fakeSql({existing:true}).sql,base(),flags),
    /destination must be empty/);
  await assert.rejects(()=>importLegacyIdentityCapture(fakeSql({parentPhones:[]}).sql,base(),flags),
    /do not match/);
  const result=await importLegacyIdentityCapture(f.sql,base(),flags);
  assert.deepEqual(result,{authProfiles:1,passkeys:1});
  assert.equal(f.writes.length,2);
  assert.equal(f.writes[0].values[1],handle);
  assert.deepEqual(Buffer.from(f.writes[1].values[2]),Buffer.from(fakePublicKey,'base64url'));
});
