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

test('own-device push check sends a generic notification only to authorized subscription',async()=>{
  const endpoint='https://push.invalid.example/synthetic',sent=[];
  const subscription={endpoint,keys:{auth:'synthetic',p256dh:'synthetic'}};
  // Endpoint SHA-256 is computed by the production service.
  const {createHash}=await import('node:crypto');
  const id=createHash('sha256').update(endpoint).digest('hex');
  const record={subscription_id:id,role:'parent',phone10:'9000000001',
    subscription_json:JSON.stringify(subscription),enabled:true};
  const sql={async begin(_options,fn){const tx=async(strings,...args)=>{
    const query=strings.join('?').replace(/\s+/g,' ').trim();
    if(query.includes('FROM push_subscriptions WHERE subscription_id='))return [[record]];
    throw new Error('Unexpected query: '+query);
  };return fn(tx);}};
  const client={setVapidDetails(){},async sendNotification(sub,payload){
    sent.push({sub,payload:JSON.parse(payload)});
  }};
  const service=createPushService({sql,env,webpushClient:client});
  assert.equal(service.dispatchStatus().dispatchEnabled,false);
  const accepted=await service.testSubscription({role:'parent',phone10:'9000000001',endpoint});
  assert.equal(accepted.ok,true);
  assert.equal(sent.length,1);
  assert.equal(sent[0].payload.body,'Проверка уведомлений. Всё работает!');
  assert.doesNotMatch(JSON.stringify(sent),/patient|child|9000000001/);
  const foreign=await service.testSubscription({role:'parent',phone10:'9000000002',endpoint});
  assert.equal(foreign.code,'SUBSCRIPTION_NOT_REGISTERED');
  assert.equal(sent.length,1);
  const wrongRole=await service.testSubscription({role:'educator',endpoint});
  assert.equal(wrongRole.code,'SUBSCRIPTION_NOT_REGISTERED');
});

test('same browser may transfer push subscription from former parent identity to verified educator',async()=>{
  const endpoint='https://push.invalid.example/shared-device';
  const stored={role:'parent',phone10:'9000000001',enabled:true,disabled_reason:''};
  const sql={async begin(_options,fn){
    const tx=async(strings,...args)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.includes('FROM push_subscriptions WHERE subscription_id='))return [[stored]];
      throw new Error('Unexpected SQL: '+query);
    };
    tx.upsert=async(strings,...args)=>{
      const query=strings.join('?');
      assert.match(query,/INSERT INTO push_subscriptions/);
      stored.role=args[1];stored.phone10=args[2];stored.enabled=args[4];
    };
    return fn(tx);
  }};
  const service=createPushService({sql,env,webpushClient:{setVapidDetails(){}}});
  const result=await service.subscribe({role:'educator',subscription:{
    endpoint,keys:{auth:'synthetic-auth',p256dh:'synthetic-key'}
  }});
  assert.equal(result.ok,true);
  assert.equal(stored.role,'educator');
  assert.equal(stored.phone10,'');
  assert.equal(stored.enabled,true);
});
