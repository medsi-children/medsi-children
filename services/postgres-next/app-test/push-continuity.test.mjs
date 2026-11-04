import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,createHash} from 'node:crypto';
import {prepareLegacyPushCapture,importLegacyPushCapture,verifyVapidKeyPair} from '../app/push-continuity.mjs';

const ecdh=createECDH('prime256v1');
ecdh.setPrivateKey(Buffer.alloc(32,1));
const vapid=ecdh.getPublicKey().toString('base64url');
const vapidPrivate=ecdh.getPrivateKey().toString('base64url');
const endpoint=i=>'https://push.invalid.example/subscription/'+i;
function entry(i,{role='parent',enabled=true,phone10='9000000001',disabledReason='user_disabled'}={}) {
  const url=endpoint(i);
  const key=createHash('sha256').update(url).digest('hex');
  const value={role,phone10:role==='educator'?'':phone10,
    subscription:{endpoint:url,keys:{auth:'synthetic-auth-'+i,p256dh:'synthetic-key-'+i}},
    enabled,updatedAt:'2026-11-03T10:00:00.000Z'};
  if(!enabled)value.disabledReason=disabledReason;
  return {key:'sub:'+key,value:JSON.stringify(value)};
}
const args=(entries)=>({
  sourceVapidPublicKey:vapid,targetVapidPublicKey:vapid,
  targetVapidPrivateKey:vapidPrivate,expectedCount:entries.length
});
function fakeSql(existing=false) {
  const saved=[];
  const sql={async begin(opts,fn){
    assert.equal(opts.isolation,'serializableReadWrite');
    const tx=async (strings,...values)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.startsWith('SELECT subscription_id'))return [existing?[{subscription_id:'old'}]:[]];
      if(q.startsWith('INSERT INTO push_subscriptions')){saved.push(values);return [];}
      throw new Error('Unexpected synthetic SQL: '+q);
    };
    tx.upsert=tx;
    return fn(tx);
  }};
  return {sql,saved};
}
test('legacy enabled and disabled choices and Web Push encryption keys are preserved',()=>{
  const entries=[entry('one'),entry('two',{enabled:false}),entry('three',{role:'educator'})];
  const result=prepareLegacyPushCapture(entries,args(entries));
  assert.equal(result.length,3);
  assert.deepEqual(result.map(row=>row.enabled),[true,false,true]);
  assert.deepEqual(result.map(row=>row.disabledReason),['','user_disabled','']);
  assert.equal(result[2].role,'educator');
  assert.equal(result[2].phone10,'');
  assert.equal(JSON.parse(result[0].subscriptionJson).keys.auth,'synthetic-auth-one');
});
test('wrong VAPID, incomplete capture and duplicate endpoint are hard blocks',()=>{
  const rows=[entry('one')];
  assert.throws(()=>prepareLegacyPushCapture(rows,{
    ...args(rows),targetVapidPublicKey:'rotated-public-key'}),/VAPID/);
  assert.throws(()=>prepareLegacyPushCapture(rows,{
    ...args(rows),expectedCount:2}),/Incomplete/);
  assert.throws(()=>prepareLegacyPushCapture([rows[0],rows[0]],{
    ...args(rows),expectedCount:2}),/duplicate/);
  const wrong=[{...rows[0],key:'sub:'+'a'.repeat(64)}];
  assert.throws(()=>prepareLegacyPushCapture(wrong,args(wrong)),/key mismatch/);
});
test('malformed or ambiguous opt-out records are rejected',()=>{
  const e=entry('one');
  for(const edit of [
    v=>{v.enabled=true;v.disabledReason='user_disabled';},
    v=>{v.enabled=false;v.disabledReason='unknown_reason';},
    v=>{v.enabled=false;delete v.disabledReason;},
    v=>{v.role='parent';v.phone10='';},
    v=>{v.subscription.keys.auth='';},
    v=>{v.updatedAt='not-a-date';}
  ]) {
    const value=JSON.parse(e.value);edit(value);
    const invalid=[{key:e.key,value}];
    assert.throws(()=>prepareLegacyPushCapture(invalid,args(invalid)));
  }
});
test('offline import requires write fence, opt-in, and an empty destination',async()=>{
  const rows=[entry('one'),entry('two',{enabled:false,disabledReason:'permission_revoked'}),
    entry('three',{enabled:false,disabledReason:'subscription_expired'})];
  const {sql,saved}=fakeSql();
  await assert.rejects(()=>importLegacyPushCapture(sql,rows,args(rows)),/explicit operator/);
  assert.equal(saved.length,0);
  const flags={...args(rows),freezeConfirmed:true,explicitImport:true};
  await assert.rejects(()=>importLegacyPushCapture(fakeSql(true).sql,rows,flags),
    /destination must be empty/);
  const result=await importLegacyPushCapture(sql,rows,flags);
  assert.deepEqual(result,{imported:3,enabled:1,disabled:2});
  assert.equal(saved.length,3);
  assert.equal(saved[0][4],true);
  assert.equal(saved[1][4],false);
  assert.equal(saved[1][5],'permission_revoked');
  assert.equal(saved[2][5],'subscription_expired');
});

test('VAPID private signing key must derive the same public key as the legacy subscription',()=>{
  assert.equal(verifyVapidKeyPair(vapid,vapidPrivate),true);
  const other=createECDH('prime256v1');
  other.setPrivateKey(Buffer.alloc(32,2));
  assert.equal(verifyVapidKeyPair(vapid,other.getPrivateKey().toString('base64url')),false);
});
