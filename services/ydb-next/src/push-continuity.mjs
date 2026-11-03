import {createHash,timingSafeEqual} from 'node:crypto';
import {Uint64} from '@ydbjs/value/primitive';

// Offline, operator-controlled import of a FROZEN legacy Cloudflare KV capture.
// Never log or expose the capture: it contains Web Push endpoint and encryption
// keys. No Cloudflare/Timeweb/Google network access is performed here.
const HEX=/^[a-f0-9]{64}$/;
const PHONE=/^\d{10}$/;
const sha=s=>createHash('sha256').update(s,'utf8').digest('hex');

function keyMatches(a,b) {
  const left=Buffer.from(String(a)),right=Buffer.from(String(b));
  return left.length===right.length&&timingSafeEqual(left,right);
}
export function prepareLegacyPushCapture(entries,{sourceVapidPublicKey,
  targetVapidPublicKey,expectedCount}={}) {
  if(!Array.isArray(entries)||entries.length>1000 ||
     !Number.isSafeInteger(expectedCount)||expectedCount<0||
     entries.length!==expectedCount)throw new Error('Incomplete push capture.');
  if(!sourceVapidPublicKey||!targetVapidPublicKey||
     !keyMatches(sourceVapidPublicKey,targetVapidPublicKey)){
    throw new Error('Push continuity blocked: VAPID public key mismatch.');
  }
  const prepared=[],seen=new Set();
  for(const entry of entries) {
    let value;
    try {value=typeof entry?.value==='string'?JSON.parse(entry.value):entry?.value;}
    catch (_) {throw new Error('Invalid push capture record.');}
    if(!value||typeof value!=='object'||Array.isArray(value)||
       !String(entry.key||'').startsWith('sub:')){
      throw new Error('Invalid push capture record.');
    }
    const endpoint=String(value.subscription?.endpoint||'');
    let url;
    try{url=new URL(endpoint);}catch(_){throw new Error('Invalid push subscription.');}
    if(url.protocol!=='https:'||endpoint.length>2048||
       typeof value.subscription?.keys?.auth!=='string'||
       !value.subscription.keys.auth||value.subscription.keys.auth.length>256||
       typeof value.subscription.keys.p256dh!=='string'||
       !value.subscription.keys.p256dh||value.subscription.keys.p256dh.length>512){
      throw new Error('Invalid push subscription.');
    }
    const digest=sha(endpoint);
    if(!HEX.test(digest)||entry.key!=='sub:'+digest||seen.has(digest)){
      throw new Error('Push capture key mismatch or duplicate.');
    }
    seen.add(digest);
    const role=value.role;
    const phone10=String(value.phone10||'');
    if(!['parent','educator'].includes(role)||
       (role==='parent'&&!PHONE.test(phone10))||
       (role==='educator'&&phone10!=='')){
      throw new Error('Invalid push subscription identity.');
    }
    if(typeof value.enabled!=='boolean'||
       (value.enabled&&value.disabledReason)){
      throw new Error('Ambiguous push opt-in state.');
    }
    const updatedAt=Date.parse(String(value.updatedAt||value.createdAt||''));
    if(!Number.isSafeInteger(updatedAt)||updatedAt<1) {
      throw new Error('Missing push subscription timestamp.');
    }
    const subscription={
      endpoint,expirationTime:value.subscription.expirationTime??null,
      keys:{auth:value.subscription.keys.auth,p256dh:value.subscription.keys.p256dh}
    };
    prepared.push({subscriptionId:digest,role,phone10,enabled:value.enabled,
      updatedAt,subscriptionJson:JSON.stringify(subscription)});
  }
  return prepared;
}

export async function importLegacyPushCapture(sql,rows,{
  sourceVapidPublicKey,targetVapidPublicKey,expectedCount,
  freezeConfirmed=false,explicitImport=false
}={}) {
  const prepared=prepareLegacyPushCapture(rows,{
    sourceVapidPublicKey,targetVapidPublicKey,expectedCount});
  if(!freezeConfirmed||!explicitImport||!sql?.begin) {
    throw new Error('Push import requires a frozen capture and explicit operator approval.');
  }
  // Single serializable transaction; destination must be empty to avoid
  // overwriting a fresh user opt-out or an in-flight browser re-subscription.
  await sql.begin({isolation:'serializableReadWrite',idempotent:false},async tx=>{
    const [prior]=await tx`SELECT subscription_id FROM push_subscriptions LIMIT 1`;
    if(prior.length)throw new Error('Push import destination must be empty.');
    for(const r of prepared) {
      await tx`UPSERT INTO push_subscriptions
        (subscription_id,role,phone10,subscription_json,enabled,updated_at)
        VALUES (${r.subscriptionId},${r.role},${r.phone10},${r.subscriptionJson},
          ${r.enabled},${new Uint64(BigInt(r.updatedAt))})`;
    }
  });
  return {imported:prepared.length,enabled:prepared.filter(x=>x.enabled).length,
    disabled:prepared.filter(x=>!x.enabled).length};
}
