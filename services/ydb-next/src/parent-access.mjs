import {createHash, timingSafeEqual} from 'node:crypto';
import {Uint64} from '@ydbjs/value/primitive';

const PHONE=/^\\d{10}$/;
const REQUEST=/^auth_[A-Za-z0-9_-]{10,120}$/;
const SECRET=/^[A-Za-z0-9_-]{35,150}$/;
const TTL=24*60*60*1000;
const RECOVERY=24*60*60*1000;
const numeric=n=>new Uint64(BigInt(n));
const hash=s=>createHash('sha256').update(s,'utf8').digest('hex');
function same(a,b) {
  const left=Buffer.from(String(a||''),'utf8'),right=Buffer.from(String(b||''),'utf8');
  return left.length===right.length && timingSafeEqual(left,right);
}
function validate({phone,requestId,requestSecret}) {
  const phone10=String(phone||'').replace(/\\D/g,'').slice(-10);
  if(!PHONE.test(phone10))throw new Error('Invalid recovery phone.');
  if(!REQUEST.test(String(requestId||''))||!SECRET.test(String(requestSecret||'')))throw new Error('Invalid recovery request.');
  return {phone10,id:String(requestId),secretHash:hash(String(requestSecret))};
}

// Staff approval is mandatory. Possession of a telephone number alone must
// never grant access to children's medical reports or private conversations.
export function createParentAccessService({sql,sessions,now=()=>Date.now()}) {
  if(!sql?.begin||!sessions?.issueParent)throw new Error('Parent access dependencies unavailable.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  async function hasKey(tx,phone10) {
    const [[auth]]=await tx`SELECT user_handle FROM parent_auth_profiles WHERE phone10=${phone10}`;
    if(!auth?.user_handle)return false;
    const [keys]=await tx`SELECT credential_id,revoked_at FROM parent_passkeys WHERE user_handle=${auth.user_handle}`;
    return keys.some(key=>Number(key.revoked_at||0)===0);
  }
  async function request(payload) {
    const {phone10,id,secretHash}=validate(payload);
    return write(async tx=>{
      const [[profile]]=await tx`SELECT phone10 FROM parent_profiles WHERE phone10=${phone10}`;
      if(!profile)return {ok:false,code:'NOT_FOUND',message:'Этот номер не найден среди активных родителей.'};
      if(await hasKey(tx,phone10))return {ok:true,status:'PASSKEY_REQUIRED'};
      const [[existing]]=await tx`SELECT phone10,request_secret_hash,status,expires_at FROM parent_access_requests WHERE request_id=${id}`;
      if(existing){
        if(existing.phone10!==phone10||!same(existing.request_secret_hash,secretHash)){
          throw new Error('Invalid recovery request collision.');
        }
        return {ok:true,status:Number(existing.expires_at)<=now()?'EXPIRED':String(existing.status||'PENDING')};
      }
      const created=now();
      await tx`UPSERT INTO parent_access_requests
        (request_id,phone10,request_secret_hash,status,decision,created_at,updated_at,expires_at)
        VALUES (${id},${phone10},${secretHash},${'PENDING'},${''},
                ${numeric(created)},${numeric(created)},${numeric(created+TTL)})`;
      return {ok:true,status:'PENDING'};
    });
  }
  async function status(payload) {
    const {phone10,id,secretHash}=validate(payload);
    const state=await write(async tx=>{
      const [[row]]=await tx`SELECT request_id,phone10,request_secret_hash,status,decision,
        created_at,updated_at,expires_at FROM parent_access_requests WHERE request_id=${id}`;
      if(!row||row.phone10!==phone10||!same(row.request_secret_hash,secretHash))return {status:'NOT_FOUND'};
      if(Number(row.expires_at)<=now()&&['PENDING','APPROVED'].includes(row.status)){
        await tx`UPDATE parent_access_requests SET status=${'EXPIRED'},updated_at=${numeric(now())} WHERE request_id=${id}`;
        return {status:'EXPIRED'};
      }
      if(await hasKey(tx,phone10))return {status:'PASSKEY_REQUIRED'};
      const [[profile]]=await tx`SELECT parent_name,child_id FROM parent_profiles WHERE phone10=${phone10}`;
      if(!profile)return {status:'NOT_FOUND'};
      if(row.status==='APPROVED'){
        await tx`UPDATE parent_access_requests SET status=${'CONSUMED'},updated_at=${numeric(now())} WHERE request_id=${id}`;
        return {status:'APPROVED',profile};
      }
      if(row.status==='CONSUMED'&&now()-Number(row.updated_at)<=RECOVERY)return {status:'APPROVED',profile};
      return {status:String(row.status||'NOT_FOUND')};
    });
    if(state.status!=='APPROVED')return {ok:true,status:state.status};
    const session=await sessions.issueParent(phone10);
    const child=await read(async tx=>{
      const [[c]]=await tx`SELECT registered_first_name,surname FROM children WHERE child_id=${state.profile.child_id}`;
      return c||{};
    });
    return {ok:true,status:'APPROVED',phone:'8'+phone10,
      parentName:state.profile.parent_name||'',
      childName:[child.registered_first_name,child.surname].filter(Boolean).join(' '),
      parentSession:session.token,d1Session:{ok:true,...session}};
  }
  async function listPending() {
    return read(async tx=>{
      const [rows]=await tx`SELECT request_id,phone10,status,created_at,expires_at FROM parent_access_requests WHERE status=${'PENDING'}`;
      return {ok:true,requests:rows.filter(row=>Number(row.expires_at)>now())
        .map(row=>({requestId:row.request_id,phone:'8'+row.phone10,
          createdAt:Number(row.created_at),expiresAt:Number(row.expires_at)}))};
    });
  }
  async function decide({requestId,decision}) {
    const id=String(requestId||''),choice=String(decision||'').toUpperCase();
    if(!REQUEST.test(id)||!['APPROVE','DENY'].includes(choice))throw new Error('Invalid recovery decision.');
    return write(async tx=>{
      const [[row]]=await tx`SELECT request_id,phone10,status,expires_at FROM parent_access_requests WHERE request_id=${id}`;
      if(!row||row.status!=='PENDING'||Number(row.expires_at)<=now())return {ok:false,code:'REQUEST_EXPIRED'};
      if(await hasKey(tx,row.phone10))return {ok:false,code:'PASSKEY_REQUIRED'};
      const [[profile]]=await tx`SELECT phone10 FROM parent_profiles WHERE phone10=${row.phone10}`;
      if(!profile)return {ok:false,code:'NOT_FOUND'};
      const status=choice==='APPROVE'?'APPROVED':'DENIED';
      await tx`UPDATE parent_access_requests
        SET status=${status},decision=${choice},updated_at=${numeric(now())}
        WHERE request_id=${id}`;
      return {ok:true,status};
    });
  }
  return {request,status,listPending,decide};
}
