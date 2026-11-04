
const PHONE=/^\d{10}$/;
const OP=/^del_[A-Za-z0-9_-]{12,125}$/;
const num=n=>BigInt(n);
const phoneOf=p=>String(p||'').replace(/\D/g,'').slice(-10);
const MAX_ATTEMPTS=6;
const LEASE_MS=10*60*1000;

export function createParentDeletionService({sql,removeMedia,enabled=false,now=()=>Date.now()}) {
  if(!sql?.begin)throw new Error('Deletion requires a PostgreSQL query client.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  const ensureEnabled=()=>{
    if(!enabled)throw new Error('Parent deletion temporarily disabled until migration audit.');
  };
  async function enqueue({phone,operationId}) {
    ensureEnabled();
    const phone10=phoneOf(phone),id=String(operationId||'');
    if(!PHONE.test(phone10)||!OP.test(id))throw new Error('Invalid parent deletion request.');
    return write(async tx=>{
      const [[existing]]=await tx`SELECT operation_id,phone10,status FROM parent_deletion_queue WHERE operation_id=${id}`;
      if(existing){
        if(existing.phone10!==phone10)throw new Error('Invalid parent deletion identifier collision.');
        return {ok:true,accepted:true,operationId:id,status:existing.status,duplicate:true};
      }
      const [jobs]=await tx`SELECT operation_id,phone10,status FROM parent_deletion_queue WHERE phone10=${phone10}`;
      const pending=jobs.find(j=>['pending','retry','processing','failed'].includes(j.status));
      if(pending)return {ok:true,accepted:true,operationId:pending.operation_id,status:pending.status,duplicate:true};
      const [[profile]]=await tx`SELECT phone10,parent_name,child_id,admission_id,profile_generation
        FROM parent_profiles WHERE phone10=${phone10}`;
      if(!profile)return {ok:false,code:'PROFILE_NOT_FOUND'};
      const timestamp=now();
      await tx.upsert`INSERT INTO parent_deletion_queue
        (operation_id,phone10,parent_name,child_id,admission_id,profile_generation,
        status,attempts,last_error,created_at,updated_at)
        VALUES (${id},${phone10},${String(profile.parent_name||'')},
          ${String(profile.child_id||'')},${String(profile.admission_id||'')},
          ${String(profile.profile_generation||'')},${'pending'},${num(0)},${''},
          ${num(timestamp)},${num(timestamp)})`;
      // Logical deletion first: all parent tokens are rejected immediately.
      // Keep children/admissions/reports for other active parents.
      await tx`DELETE FROM parent_profiles WHERE phone10=${phone10}`;
      await tx`UPDATE parent_access_requests SET status=${'DENIED'},decision=${'REVOKED'},
        updated_at=${num(timestamp)} WHERE phone10=${phone10}`;
      return {ok:true,accepted:true,operationId:id,status:'pending'};
    });
  }
  async function status(operationId) {
    const id=String(operationId||'');
    if(!OP.test(id))throw new Error('Invalid parent deletion identifier.');
    return read(async tx=>{
      const [[row]]=await tx`SELECT operation_id,phone10,child_id,status,attempts,last_error,updated_at
        FROM parent_deletion_queue WHERE operation_id=${id}`;
      if(!row)return {ok:true,operationId:id,status:'not_found'};
      return {ok:true,operationId:id,phone:row.phone10,status:row.status,
        attempts:Number(row.attempts||0),message:row.last_error||'',updatedAt:Number(row.updated_at||0)};
    });
  }
  async function pending() {
    return read(async tx=>{
      const [rows]=await tx`SELECT operation_id,phone10,child_id,status,attempts,last_error,updated_at
        FROM parent_deletion_queue`;
      return {ok:true,operations:rows.filter(j=>['pending','retry','processing','failed'].includes(j.status))
        .sort((a,b)=>Number(b.updated_at||0)-Number(a.updated_at||0)).slice(0,30)
        .map(j=>({operationId:j.operation_id,phone:j.phone10,childName:'',
          status:j.status,attempts:Number(j.attempts||0),message:j.last_error||'',updatedAt:Number(j.updated_at||0)}))};
    });
  }
  async function retry(operationId) {
    ensureEnabled();
    const id=String(operationId||'');
    if(!OP.test(id))throw new Error('Invalid parent deletion identifier.');
    return write(async tx=>{
      const [[row]]=await tx`SELECT operation_id,status FROM parent_deletion_queue WHERE operation_id=${id}`;
      if(!row)return {ok:false,code:'NOT_FOUND'};
      if(row.status==='failed'){
        await tx`UPDATE parent_deletion_queue SET status=${'retry'},attempts=${num(0)},
          last_error=${''},updated_at=${num(now())} WHERE operation_id=${id}`;
        return {ok:true,operationId:id,status:'retry'};
      }
      return {ok:true,operationId:id,status:row.status};
    });
  }
  async function claim() {
    return write(async tx=>{
      const [jobs]=await tx`SELECT operation_id,phone10,status,attempts,updated_at,created_at
        FROM parent_deletion_queue`;
      const candidate=jobs.filter(r=>['pending','retry'].includes(r.status)||
          (r.status==='processing'&&Number(r.updated_at||0)<now()-LEASE_MS))
        .sort((a,b)=>Number(a.created_at||0)-Number(b.created_at||0))[0];
      if(!candidate)return null;
      await tx`UPDATE parent_deletion_queue
        SET status=${'processing'},attempts=${num(Number(candidate.attempts||0)+1)},
        updated_at=${num(now())} WHERE operation_id=${candidate.operation_id}`;
      return {...candidate,attempts:Number(candidate.attempts||0)+1};
    });
  }
  async function processNext() {
    ensureEnabled();
    if(typeof removeMedia!=='function')throw new Error('Secure S3 cleanup is not configured.');
    const job=await claim();
    if(!job)return {ok:true,skipped:true};
    const phone10=job.phone10,id=job.operation_id;
    try {
      const rows=await read(async tx=>{
        const [messages]=await tx`SELECT file_id FROM chat_messages WHERE phone10=${phone10}`;
        const [uploads]=await tx`SELECT file_id FROM chat_media WHERE phone10=${phone10}`;
        return [...messages,...uploads];
      });
      const keys=[...new Set(rows.map(r=>String(r.file_id||'')).filter(Boolean))];
      if(keys.length>20000)throw new Error('Media cleanup batch too large.');
      for(const media of keys) {
        if(media.startsWith('kv:')||media.startsWith('r2:')){
          throw new Error('Legacy media must be migrated before profile deletion.');
        }
        if(!media.startsWith('s3:'))continue;
        const key=media.slice(3);
        if(!/^(?:chat\/[A-Za-z0-9._-]{8,180}|[a-f0-9-]{36}\.[a-z0-9]{2,5})$/.test(key)){
          throw new Error('Unrecognized S3 object identifier.');
        }
        const shared=await read(async tx=>{
          const [references]=await tx`SELECT phone10 FROM chat_messages WHERE file_id=${media}`;
          return references.some(r=>r.phone10!==phone10);
        });
        if(!shared)await removeMedia(key);
      }
      await write(async tx=>{
        // Two parents of one child keep independent histories and accounts.
        const [[current]]=await tx`SELECT operation_id,status FROM parent_deletion_queue WHERE operation_id=${id}`;
        if(!current||current.status!=='processing')throw new Error('Parent deletion lease lost.');
        const [[recreated]]=await tx`SELECT phone10 FROM parent_profiles WHERE phone10=${phone10}`;
        if(recreated)throw new Error('Parent profile was recreated during deletion.');
        const [[auth]]=await tx`SELECT user_handle FROM parent_auth_profiles WHERE phone10=${phone10}`;
        if(auth?.user_handle)await tx`DELETE FROM parent_passkeys WHERE user_handle=${auth.user_handle}`;
        for(const table of ['chat_messages','chat_message_dedup','chat_thread_state','chat_pins',
          'chat_sessions','chat_media','parent_auth_profiles','parent_auth_challenges','parent_registration_attempts',
          'parent_access_requests','push_subscriptions','push_outbox',
          'parent_current_reports','parent_report_history']) {
          // Identifier is statically allowlisted, only the phone is parameterized.
          await tx`DELETE FROM ${sql.identifier(table)} WHERE phone10 = ${phone10}`;
        }
        await tx`UPDATE parent_deletion_queue SET status=${'completed'},last_error=${''},
          updated_at=${num(now())} WHERE operation_id=${id}`;
      });
      return {ok:true,operationId:id,status:'completed'};
    }catch(_error) {
      const final=job.attempts>=MAX_ATTEMPTS;
      await write(async tx=>{
        await tx`UPDATE parent_deletion_queue SET
          status=${final?'failed':'retry'},
          last_error=${'Не удалось завершить удаление. Проверьте журнал сервера.'},
          updated_at=${num(now())} WHERE operation_id=${id} AND status=${'processing'}`;
      });
      return {ok:false,operationId:id,status:final?'failed':'retry'};
    }
  }
  return {enqueue,status,pending,retry,processNext};
}
