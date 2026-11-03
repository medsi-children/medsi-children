import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareLegacyPushCapture,importLegacyPushCapture} from '../src/push-continuity.mjs';

const vapid='old-public-vapid-test-only';
const endpoint=i=>'https://push.invalid.example/subscription/'+i;
function entry(i,{role='parent',enabled=true,phone10='9000000001'}={}) {
  const url=endpoint(i);
  const key=createHash('sha256').update(url).digest('hex');
  const value={role,phone10:role==='educator'?'':phone10,
    subscription:{endpoint:url,keys:{auth:'synthetic-auth-'+i,p256dh:'synthetic-key-'+i}},
    enabled,updatedAt:'2026-11-03T10:00:00.000Z'};
  if(!enabled)value.disabledReason='user_disabled';
  return {key:'sub:'+key,value:JSON.stringify(value)};
}
const args=(entries)=>({
  sourceVapidPublicKey:vapid,targetVapidPublicKey:vapid,expectedCount:entries.length
});
function fakeSql(existing=false) {
  const saved=[];
  const sql={async begin(opts,fn){
    assert.equal(opts.isolation,'serializableReadWrite');
    const tx=async (strings,...values)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.startsWith('SELECT subscription_id'))return [existing?[{subscription_id:'old'}]:[]];
      if(q.startsWith('UPSERT INTO push_subscriptions')){saved.push(values);return [];}
      throw new Error('Unexpected synthetic SQL: '+q);
    };
    return fn(tx);
  }};
  return {sql,saved};
}
test('legacy enabled and disabled choices and Web Push encryption keys are preserved',()=>{
  const entries=[entry('one'),entry('two',{enabled:false}),entry('three',{role:'educator'})];
  const result=prepareLegacyPushCapture(entries,args(entries));
  assert.equal(result.length,3);
  assert.deepEqual(result.map(row=>row.enabled),[true,false,true]);
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
  const rows=[entry('one'),entry('two',{enabled:false})];
  const {sql,saved}=fakeSql();
  await assert.rejects(()=>importLegacyPushCapture(sql,rows,args(rows)),/explicit operator/);
  assert.equal(saved.length,0);
  const flags={...args(rows),freezeConfirmed:true,explicitImport:true};
  await assert.rejects(()=>importLegacyPushCapture(fakeSql(true).sql,rows,flags),
    /destination must be empty/);
  const result=await importLegacyPushCapture(sql,rows,flags);
  assert.deepEqual(result,{imported:2,enabled:1,disabled:1});
  assert.equal(saved.length,2);
  assert.equal(saved[0][4],true);
  assert.equal(saved[1][4],false);
});
