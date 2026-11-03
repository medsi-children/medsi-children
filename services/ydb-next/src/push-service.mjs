import {createHash} from 'node:crypto';
import {Uint64} from '@ydbjs/value/primitive';
import webpush from 'web-push';

const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const PHONE=/^\d{10}$/;
const VALID_ROLES=new Set(['parent','educator']);
// A crashed dispatcher must not strand an outbox event in 'processing'.
const PROCESSING_LEASE_MS=5*60*1000;
const nowUint=()=>new Uint64(BigInt(Date.now()));

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
  if(!sql?.begin)throw new Error('YDB query client required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
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
      const now=nowUint();
      await tx`UPSERT INTO push_subscriptions
        (subscription_id,role,phone10,subscription_json,enabled,updated_at)
        VALUES (${id},${role},${role==='parent'?phone10:''},
          ${JSON.stringify(data)},${true},${now})`;
      return {ok:true,key:id};
    });
  }
  async function unsubscribe({endpoint,role,phone10=''}) {
    const id=sha(String(endpoint||''));
    if(!VALID_ROLES.has(role)||(role==='parent'&&!PHONE.test(phone10)))throw new Error('Invalid role or phone.');
    return write(async tx=>{
      const [[row]]=await tx`SELECT role,phone10 FROM push_subscriptions
        WHERE subscription_id=${id}`;
      if(row && (row.role!==role || (role==='parent' && row.phone10!==phone10))) {
        throw new Error('Subscription belongs to another account.');
      }
      if(row) await tx`UPDATE push_subscriptions SET enabled=${false},updated_at=${nowUint()}
        WHERE subscription_id=${id}`;
      return {ok:true};
    });
  }
  async function deliverEvent(eventId) {
    ensureConfigured();
    if(!/^[a-z0-9_-]{16,160}$/i.test(String(eventId||'')))throw new Error('Invalid push event.');
    const now=Date.now();
    const job=await write(async tx=>{
      const [[row]]=await tx`SELECT event_id,role,phone10,notification_json,status,attempts,next_attempt_at
        FROM push_outbox WHERE event_id=${eventId}`;
      if(!row||!['pending','retry','processing'].includes(row.status)||
         Number(row.next_attempt_at||0)>now)return null;
      const attempt=Number(row.attempts||0)+1;
      const leaseUntil=now+PROCESSING_LEASE_MS;
      await tx`UPDATE push_outbox
        SET status=${'processing'},attempts=${new Uint64(BigInt(attempt))},
            next_attempt_at=${new Uint64(BigInt(leaseUntil))}
        WHERE event_id=${eventId}`;
      return {...row,attempt,leaseUntil};
    });
    if(!job)return {ok:true,skipped:true};
    const [subscriptions]=await read(tx=>tx`SELECT subscription_id,role,phone10,subscription_json,enabled
      FROM push_subscriptions`);
    const targets=subscriptions.filter(s=>s.enabled&&s.role===job.role&&
      (job.role==='educator'||s.phone10===job.phone10));
    let failed=0,sent=0;
    const attempts=job.attempt;
    for(const target of targets) {
      try {
        const payload=JSON.parse(job.notification_json||'{}');
        // All producers must use generic message/report notices, never patient text.
        if(!['chat','report'].includes(payload.type))throw new Error('Unexpected push payload type.');
        await webpushClient.sendNotification(JSON.parse(target.subscription_json),JSON.stringify(payload));
        sent++;
      }catch(error) {
        if([404,410].includes(Number(error?.statusCode))) {
          await write(async tx=>{await tx`UPDATE push_subscriptions
            SET enabled=${false},updated_at=${nowUint()}
            WHERE subscription_id=${target.subscription_id}`;});
        }else failed++;
      }
    }
    await write(async tx=>{
      const nextStatus=failed?(attempts<6?'retry':'failed'):'completed';
      const due=new Uint64(BigInt(now+Math.min(3600000,10000*2**Math.min(8,attempts))));
      // A late sender may not overwrite a newer attempt which recovered its lease.
      await tx`UPDATE push_outbox
        SET status=${nextStatus},next_attempt_at=${due}
        WHERE event_id=${eventId} AND status=${'processing'}
          AND attempts=${new Uint64(BigInt(attempts))}
          AND next_attempt_at=${new Uint64(BigInt(job.leaseUntil))}`;
    });
    return {ok:true,sent,failed};
  }
  async function pendingEvents(limit=30) {
    return read(async tx=>{
      const [events]=await tx`SELECT event_id,status,next_attempt_at
        FROM push_outbox WHERE status=${'pending'} OR status=${'retry'}
          OR status=${'processing'}`;
      return events.filter(r=>Number(r.next_attempt_at||0)<=Date.now()).slice(0,Math.max(1,Math.min(100,limit)))
        .map(r=>r.event_id);
    });
  }
  return {subscribe,unsubscribe,deliverEvent,pendingEvents};
}
