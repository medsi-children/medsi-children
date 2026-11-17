import {createHash} from 'node:crypto';
import webpush from 'web-push';

const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const PHONE=/^\d{10}$/;
const VALID_ROLES=new Set(['parent','educator']);
// A crashed dispatcher must not strand an outbox event in 'processing'.
const PROCESSING_LEASE_MS=5*60*1000;
// Push is an ephemeral signal; the message/report remains in PostgreSQL.
// Strict age and batch caps prevent delayed floods after outages.
const MAX_PUSH_AGE_MS=3*60*1000;
const MAX_PUSH_EVENTS_PER_TICK=12;
const MAX_PUSH_ATTEMPTS=5;
const CUTOVER_KEY='push_dispatch_safe_activation_v3';
const nowUint=()=>BigInt(Date.now());

function validateSubscription(value) {
  const endpoint=String(value?.endpoint||'');
  let url;
  try{url=new URL(endpoint);}catch(_){throw new Error('Invalid Web Push endpoint.');}
  if(url.protocol!=='https:'||endpoint.length>2048)throw new Error('Invalid Web Push endpoint.');
  const auth=String(value?.keys?.auth||''),p256dh=String(value?.keys?.p256dh||'');
  if(!auth||!p256dh||auth.length>256||p256dh.length>512)throw new Error('Invalid Web Push keys.');
  return {endpoint,expirationTime:value.expirationTime||null,keys:{auth,p256dh}};
}

export function createPushService({sql,env=process.env,webpushClient=webpush}) {
  if(!sql?.begin)throw new Error('PostgreSQL query client required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  // The activation boundary is created only after the dispatcher is explicitly
  // enabled. Persist it so an ordinary process restart can finish recent events,
  // without ever replaying historical notifications queued while push was off.
  let activationPromise=null;
  function activationStart(){
    if(!activationPromise){
      activationPromise=write(async tx=>{
        await tx`INSERT INTO migration_state (stream_id,cursor_value)
          VALUES (${CUTOVER_KEY},${String(Date.now())})
          ON CONFLICT (stream_id) DO NOTHING`;
        const [[record]]=await tx`SELECT cursor_value FROM migration_state
          WHERE stream_id=${CUTOVER_KEY}`;
        const value=Number(record?.cursor_value);
        if(!Number.isSafeInteger(value)||value<=0||value>Date.now()+60000)
          throw new Error('Push activation boundary unavailable.');
        return BigInt(value);
      }).catch(error=>{activationPromise=null;throw error});
    }
    return activationPromise;
  }
  // Rate-limit generic operational logs. Never log endpoints, account
  // numbers, message text, subscription secrets, or notification payloads.
  const lastNotice=new Map();
  function logPush(code){
    const now=Date.now();
    if(now-(lastNotice.get(code)||0)<60000)return;
    lastNotice.set(code,now);
    console.warn('MEDSI_PUSH_'+code);
  }
  async function subscriptionCounts(){
    const [counts]=await read(tx=>tx`SELECT role,COUNT(*) AS n
      FROM push_subscriptions WHERE enabled=${true} GROUP BY role`);
    const byRole={parent:0,educator:0};
    for(const item of counts){
      if(Object.hasOwn(byRole,item.role))byRole[item.role]=Number(item.n)||0;
    }
    return byRole;
  }
  let configured=false;
  function ensureConfigured() {
    if(configured)return;
    if(!env.VAPID_PUBLIC_KEY||!env.VAPID_PRIVATE_KEY||!env.VAPID_SUBJECT) {
      throw new Error('Web Push VAPID configuration missing.');
    }
    webpushClient.setVapidDetails(env.VAPID_SUBJECT,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
    configured=true;
  }
  async function subscribe({role,phone10='',subscription}) {
    if(!VALID_ROLES.has(role)||(role==='parent'&&!PHONE.test(phone10)))throw new Error('Invalid role or phone.');
    const data=validateSubscription(subscription);
    const id=sha(data.endpoint);
    return write(async tx=>{
      const [[prior]]=await tx`SELECT role,phone10,enabled,disabled_reason
        FROM push_subscriptions WHERE subscription_id=${id}`;
      if(prior&&(prior.role!==role||prior.phone10!==(role==='parent'?phone10:''))) {
        throw new Error('Subscription belongs to another account.');
      }
      if(prior?.disabled_reason==='subscription_expired') {
        throw Object.assign(new Error('Subscription must be renewed.'),{code:'PUSH_SUBSCRIPTION_EXPIRED'});
      }
      const now=nowUint();
      await tx.upsert`INSERT INTO push_subscriptions
        (subscription_id,role,phone10,subscription_json,enabled,disabled_reason,updated_at)
        VALUES (${id},${role},${role==='parent'?phone10:''},
          ${JSON.stringify(data)},${true},${''},${now})`;
      return {ok:true,key:id};
    });
  }
  async function unsubscribe({endpoint,role,phone10='',reason='user_disabled'}) {
    const id=sha(String(endpoint||''));
    if(!VALID_ROLES.has(role)||(role==='parent'&&!PHONE.test(phone10)))throw new Error('Invalid role or phone.');
    return write(async tx=>{
      const [[row]]=await tx`SELECT role,phone10 FROM push_subscriptions
        WHERE subscription_id=${id}`;
      if(row && (row.role!==role || (role==='parent' && row.phone10!==phone10))) {
        throw new Error('Subscription belongs to another account.');
      }
      if(row) await tx`UPDATE push_subscriptions
        SET enabled=${false},disabled_reason=${reason==='permission_revoked'?'permission_revoked':'user_disabled'},
          updated_at=${nowUint()}
        WHERE subscription_id=${id}`;
      return {ok:true};
    });
  }
  async function deliverEvent(eventId) {
    ensureConfigured();
    if(!/^[a-z0-9_-]{16,160}$/i.test(String(eventId||'')))throw new Error('Invalid push event.');
    const now=Date.now();
    const start=await activationStart();
    const cutoff=Math.max(Number(start),now-MAX_PUSH_AGE_MS);
    const job=await write(async tx=>{
      const [[row]]=await tx`SELECT event_id,role,phone10,notification_json,status,attempts,next_attempt_at,created_at
        FROM push_outbox WHERE event_id=${eventId} FOR UPDATE`;
      if(!row||!['pending','retry','processing'].includes(row.status))return null;
      // Defend the actual sender too, not only the queue scanner.
      if(Number(row.created_at||0)<=cutoff){
        await tx`UPDATE push_outbox SET status=${'expired'}
          WHERE event_id=${eventId}`;
        return {expired:true};
      }
      if(Number(row.next_attempt_at||0)>now)return null;
      const attempt=Number(row.attempts||0)+1;
      const leaseUntil=now+PROCESSING_LEASE_MS;
      await tx`UPDATE push_outbox
        SET status=${'processing'},attempts=${BigInt(attempt)},
            next_attempt_at=${BigInt(leaseUntil)}
        WHERE event_id=${eventId}`;
      return {...row,attempt,leaseUntil};
    });
    if(!job)return {ok:true,skipped:true};
    if(job.expired)return {ok:true,expired:true};
    const [subscriptions]=await read(tx=>tx`SELECT subscription_id,role,phone10,subscription_json,enabled
      FROM push_subscriptions`);
    const targets=subscriptions.filter(s=>s.enabled&&s.role===job.role&&
      (job.role==='educator'||s.phone10===job.phone10));
    if(!targets.length)logPush(job.role==='educator'
      ?'NO_EDUCATOR_TARGETS':'NO_PARENT_TARGETS');
    let failed=0,sent=0;
    const attempts=job.attempt;
    const payload=JSON.parse(job.notification_json||'{}');
    // All producers use generic notices, never message or patient text.
    if(!['chat','report'].includes(payload.type))throw new Error('Unexpected push payload type.');
    const delivered=new Set(Array.isArray(payload._deliveredSubscriptions)
      ?payload._deliveredSubscriptions.filter(x=>typeof x==='string'):[]);
    for(const target of targets) {
      // Once one device accepted an event, never send it again on a retry
      // triggered by another device's temporary push-provider failure.
      if(delivered.has(target.subscription_id))continue;
      try {
        const notice={...payload,tag:'medsi-'+sha(eventId).slice(0,20)};
        delete notice._deliveredSubscriptions;
        await webpushClient.sendNotification(JSON.parse(target.subscription_json),
          JSON.stringify(notice),{TTL:300,timeout:10000});
        delivered.add(target.subscription_id);
        await write(async tx=>{
          await tx`UPDATE push_outbox
            SET notification_json=${JSON.stringify({...payload,_deliveredSubscriptions:[...delivered]})}
            WHERE event_id=${eventId} AND status=${'processing'}
              AND attempts=${BigInt(attempts)}
              AND next_attempt_at=${BigInt(job.leaseUntil)}`;
        });
        sent++;
        logPush('PROVIDER_ACCEPTED_'+job.role.toUpperCase());
      }catch(error) {
        const status=Number(error?.statusCode)||0;
        if(status===401||status===403)logPush('PROVIDER_AUTH_REJECTED');
        else if(status===429)logPush('PROVIDER_RATE_LIMITED');
        else if(status>=500)logPush('PROVIDER_UNAVAILABLE');
        else if(status!==404&&status!==410)logPush('PROVIDER_NETWORK_OR_TIMEOUT');
        if([404,410].includes(status)) {
          logPush('SUBSCRIPTION_EXPIRED');
          await write(async tx=>{await tx`UPDATE push_subscriptions
            SET enabled=${false},disabled_reason=${'subscription_expired'},updated_at=${nowUint()}
            WHERE subscription_id=${target.subscription_id}`;});
        }else failed++;
      }
    }
    await write(async tx=>{
      const nextStatus=failed?(attempts<MAX_PUSH_ATTEMPTS?'retry':'failed'):'completed';
      const due=BigInt(now+Math.min(900000,10000*2**Math.min(8,attempts)));
      // A late sender may not overwrite a newer attempt which recovered its lease.
      await tx`UPDATE push_outbox
        SET status=${nextStatus},next_attempt_at=${due}
        WHERE event_id=${eventId} AND status=${'processing'}
          AND attempts=${BigInt(attempts)}
          AND next_attempt_at=${BigInt(job.leaseUntil)}`;
    });
    return {ok:true,sent,failed};
  }
  async function expireStale(limit=80){
    const activated=await activationStart();
    const cutoff=BigInt(Math.max(Number(activated),Date.now()-MAX_PUSH_AGE_MS));
    const count=Math.max(1,Math.min(100,Number(limit)||80));
    // Leave historical events intact for audit; only their push-delivery
    // status changes. Clinical messages and reports are never deleted here.
    return write(async tx=>{
      const [expired]=await tx`UPDATE push_outbox SET status=${'expired'}
        WHERE event_id IN (
          SELECT event_id FROM push_outbox
          WHERE (status=${'pending'} OR status=${'retry'} OR status=${'processing'})
            AND created_at<=${cutoff}
          ORDER BY created_at ASC,event_id ASC LIMIT ${count}
        ) RETURNING event_id`;
      return expired.length;
    });
  }
  async function pendingEvents(limit=MAX_PUSH_EVENTS_PER_TICK) {
    const activated=await activationStart();
    return read(async tx=>{
      const now=Date.now();
      const due=BigInt(now);
      const cutoff=BigInt(Math.max(Number(activated),now-MAX_PUSH_AGE_MS));
      const count=Math.max(1,Math.min(MAX_PUSH_EVENTS_PER_TICK,Number(limit)||MAX_PUSH_EVENTS_PER_TICK));
      const [events]=await tx`SELECT event_id FROM push_outbox
        WHERE (status=${'pending'} OR status=${'retry'} OR status=${'processing'})
          AND COALESCE(next_attempt_at,0)<=${due}
          AND created_at>${cutoff}
        ORDER BY next_attempt_at ASC,event_id ASC LIMIT ${count}`;
      return events.map(row=>row.event_id);
    });
  }
  return {subscribe,unsubscribe,deliverEvent,pendingEvents,expireStale,subscriptionCounts};
}
