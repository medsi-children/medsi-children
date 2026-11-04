import test from 'node:test';
import assert from 'node:assert/strict';
import {createPushService} from '../app/push-service.mjs';

// Purely synthetic queue rows. No real push endpoint or notification is used.
const env={VAPID_PUBLIC_KEY:'fake-public',VAPID_PRIVATE_KEY:'fake-private',VAPID_SUBJECT:'mailto:test@example.invalid'};
function makeFixture({status,nextAttemptAt,attempts=1}) {
  const row={
    event_id:'push_event_test_001',role:'parent',phone10:'9000000001',
    notification_json:JSON.stringify({type:'chat'}),status,attempts,
    next_attempt_at:nextAttemptAt
  };
  const sql={async begin(_mode,callback){
    const tx=async(strings,...params)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.includes('FROM push_outbox WHERE event_id='))return [[{...row}]];
      if(query.includes('FROM push_outbox WHERE status='))return [[{...row}]];
      if(query.includes('FROM push_subscriptions'))return [[]];
      if(query.startsWith('UPDATE push_outbox')) {
        if(query.includes(',attempts=?')) {
          row.status='processing';
          row.attempts+=1;
          row.next_attempt_at=Date.now()+300000;
        } else {
          row.status=String(params[0]);
          row.next_attempt_at=Date.now()+60000;
        }
        return [[]];
      }
      throw new Error('Unexpected SQL: '+query);
    };
    return callback(tx);
  }};
  const client={setVapidDetails(){},async sendNotification(){throw new Error('No synthetic subscriptions should be sent.');}};
  const service=createPushService({sql,env,webpushClient:client});
  return {row,service};
}
test('an abandoned processing lease is discoverable and delivered after recovery',async()=>{
  const {row,service}=makeFixture({status:'processing',nextAttemptAt:Date.now()-1000});
  assert.deepEqual(await service.pendingEvents(),[row.event_id]);
  const result=await service.deliverEvent(row.event_id);
  assert.equal(result.ok,true);
  assert.equal(result.failed,0);
  assert.equal(row.status,'completed');
  assert.equal(row.attempts,2);
  assert.deepEqual(await service.pendingEvents(),[]);
});
test('a processing event with a live lease is not claimed twice',async()=>{
  const {row,service}=makeFixture({status:'processing',nextAttemptAt:Date.now()+60000});
  assert.deepEqual(await service.pendingEvents(),[]);
  const result=await service.deliverEvent(row.event_id);
  assert.equal(result.skipped,true);
  assert.equal(row.status,'processing');
  assert.equal(row.attempts,1);
});
