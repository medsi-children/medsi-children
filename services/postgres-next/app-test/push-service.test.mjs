import test from 'node:test';
import assert from 'node:assert/strict';
import {createPushService} from '../app/push-service.mjs';

// Purely synthetic queue rows. No real push endpoint or notification is used.
const env={VAPID_PUBLIC_KEY:'fake-public',VAPID_PRIVATE_KEY:'fake-private',VAPID_SUBJECT:'mailto:test@example.invalid'};
function makeFixture({status,nextAttemptAt,attempts=1}) {
  const row={
    event_id:'push_event_test_001',role:'parent',phone10:'9000000001',
    notification_json:JSON.stringify({type:'chat'}),status,attempts,
    created_at:Date.now()+1000,
    next_attempt_at:nextAttemptAt
  };
  let activation=null;
  const sql={async begin(_mode,callback){
    const tx=async(strings,...params)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.startsWith('INSERT INTO migration_state')){activation??=Number(params[1]);return [[]]}
      if(query.startsWith('SELECT cursor_value FROM migration_state'))return [[{cursor_value:String(activation)}]];
      if(query.startsWith('UPDATE push_outbox SET status=')&&query.includes('WHERE event_id IN')){
        const cutoff=Number(params.at(-2));
        if(['pending','retry','processing'].includes(row.status)&&Number(row.created_at)<=cutoff){row.status='expired';return [[{event_id:row.event_id}]]}
        return [[]];
      }
      if(query.includes('FROM push_outbox WHERE event_id='))return [[{...row}]];
      if(query.includes('FROM push_outbox')&&query.includes('WHERE (status='))return [Number(row.next_attempt_at)<=Number(params.at(-3))&&Number(row.created_at)>Number(params.at(-2))? [{event_id:row.event_id}]:[]];
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

test('a newly enabled dispatcher never replays notifications queued before server activation',async()=>{
  const {row,service}=makeFixture({status:'pending',nextAttemptAt:Date.now()-10000,attempts:0});
  row.created_at=Date.now()-60*60*1000;
  assert.deepEqual(await service.pendingEvents(),[]);
  // The source event remains intact for an audited cleanup.
  assert.equal(row.status,'pending');
});

test('retry never resends an event to a device whose push provider already accepted it',async()=>{
  const created=Date.now();
  const row={event_id:'push_retry_synthetic_001',role:'parent',phone10:'9000000001',
    notification_json:JSON.stringify({title:'Медси Бот',body:'Новое сообщение в чате.',type:'chat'}),
    status:'pending',attempts:0,next_attempt_at:created-100,created_at:created+1000};
  const targets=[
    {subscription_id:'device-a',role:'parent',phone10:'9000000001',
      subscription_json:JSON.stringify({endpoint:'https://push.invalid.example/a'}),enabled:true},
    {subscription_id:'device-b',role:'parent',phone10:'9000000001',
      subscription_json:JSON.stringify({endpoint:'https://push.invalid.example/b'}),enabled:true}
  ];
  const calls=[];
  let failB=true;
  let activation=null;
  const sql={async begin(_mode,callback){
    const tx=async(strings,...params)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.startsWith('INSERT INTO migration_state')){activation??=Number(params[1]);return [[]]}
      if(query.startsWith('SELECT cursor_value FROM migration_state'))return [[{cursor_value:String(activation)}]];
      if(query.includes('FROM push_outbox WHERE event_id='))return [[{...row}]];
      if(query.includes('FROM push_subscriptions'))return [targets];
      if(query.startsWith('UPDATE push_outbox SET status=')){
        row.status=params[0];
        if(query.includes(',attempts=')){
          row.attempts=Number(params[1]);row.next_attempt_at=Number(params[2]);
        }else{
          row.next_attempt_at=Number(params[1]);
        }
        return [[]];
      }
      if(query.startsWith('UPDATE push_outbox SET notification_json=')){
        row.notification_json=params[0];return [[]];
      }
      throw new Error('Unexpected SQL: '+query);
    };
    return callback(tx);
  }};
  const sender={setVapidDetails(){},async sendNotification(subscription,payload){
    const data=JSON.parse(payload);
    assert.equal(data.body,'Новое сообщение в чате.');
    assert.ok(data.tag.startsWith('medsi-'));
    assert.equal(data._deliveredSubscriptions,undefined);
    calls.push(subscription.endpoint);
    if(subscription.endpoint.endsWith('/b')&&failB){failB=false;throw new Error('temporary push gateway timeout')}
  }};
  const push=createPushService({sql,env,webpushClient:sender});
  let result=await push.deliverEvent(row.event_id);
  assert.equal(result.sent,1);assert.equal(result.failed,1);
  assert.equal(row.status,'retry');
  assert.deepEqual(JSON.parse(row.notification_json)._deliveredSubscriptions,['device-a']);
  row.next_attempt_at=Date.now()-1;
  result=await push.deliverEvent(row.event_id);
  assert.equal(result.sent,1);assert.equal(result.failed,0);
  assert.equal(row.status,'completed');
  assert.deepEqual(calls,[
    'https://push.invalid.example/a',
    'https://push.invalid.example/b',
    'https://push.invalid.example/b'
  ]);
});

test('a persistent activation boundary survives process restart and never replays a disabled-period queue',async()=>{
  const {row,service}=makeFixture({status:'pending',nextAttemptAt:Date.now()-10000,attempts:0});
  row.created_at=Date.now()-2*60*60*1000;
  assert.deepEqual(await service.pendingEvents(),[]);
  assert.equal(await service.expireStale(),1);
  assert.equal(row.status,'expired');
  assert.deepEqual(await service.pendingEvents(),[]);
});
test('direct delivery of an old push fails closed even if invoked outside the queue scanner',async()=>{
  const {row,service}=makeFixture({status:'pending',nextAttemptAt:Date.now()-10000,attempts:0});
  row.created_at=Date.now()-3600000;
  const result=await service.deliverEvent(row.event_id);
  assert.equal(result.expired,true);
  assert.equal(row.status,'expired');
});

test('readiness counts include only enabled subscriptions, never endpoints or account data',async()=>{
  const sql={async begin(_opts,callback){
    const tx=async strings=>{
      const query=strings.join('?').replace(/\s+/g,' ');
      assert.match(query,/FROM push_subscriptions WHERE enabled=/);
      assert.match(query,/GROUP BY role/);
      return [[{role:'parent',n:'4'},{role:'educator',n:'2'}]];
    };
    return callback(tx);
  }};
  const service=createPushService({sql,env,webpushClient:{setVapidDetails(){}}});
  const counts=await service.subscriptionCounts();
  assert.deepEqual(counts,{parent:4,educator:2});
  assert.deepEqual(Object.keys(counts).sort(),['educator','parent']);
});
