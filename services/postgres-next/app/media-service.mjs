import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

const MAX_UPLOAD_BYTES=100*1024*1024;
const MAX_COOKIE_AGE=20*60*1000;
const PHONE=/^\d{10}$/;
const UPLOAD_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const KEY=/^(?:chat\/[a-f0-9]{64}\.[a-z0-9]{2,5}|chat\/[A-Za-z0-9._-]{8,180}|[a-f0-9-]{36}\.[a-z0-9]{2,5})$/;
export const isChatMediaKey=key=>typeof key==='string'&&KEY.test(key);
const COOKIE='medsi_media_session';
const sha=(v)=>createHash('sha256').update(v).digest('hex');
const uint=(n)=>BigInt(n);

function safeEq(a,b) {
  const left=Buffer.from(String(a||'')),right=Buffer.from(String(b||''));
  return left.length===right.length && timingSafeEqual(left,right);
}
function cookieValue(cookieString) {
  const chunk=String(cookieString||'').split(';').map(s=>s.trim())
    .find(s=>s.startsWith(COOKIE+'='));
  return chunk?chunk.slice(COOKIE.length+1):'';
}
function parseClaims(value,secret,now) {
  if(!value||value.length>2048)return null;
  const parts=value.split('.');
  if(parts.length!==2||!safeEq(createHmac('sha256',secret).update(parts[0]).digest('base64url'),parts[1]))return null;
  try {
    const claims=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    if(!claims||claims.exp<=now||claims.exp>now+MAX_COOKIE_AGE+1000 ||
       !['parent','educator'].includes(claims.role) ||
       (claims.role==='parent'&&!PHONE.test(claims.phone10)))return null;
    return claims;
  }catch(_){return null;}
}
export function createMediaService({sql,sessions,storage,secret,now=()=>Date.now(),currentChildMode=false}) {
  if(!sql?.begin||!sessions?.verifyWorker||!storage||String(secret||'').length<32) {
    throw new Error('Protected media service requires PostgreSQL, sessions, S3 and signing key.');
  }
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);

  async function activePhone(tx,phone10) {
    if(currentChildMode){
      const [[profile]]=await tx`SELECT phone10,child_id FROM parent_profiles WHERE phone10=${phone10}`;
      if(!profile)return false;
      if(!String(profile.child_id||'').trim())return true;
      const [[child]]=await tx`SELECT child_id FROM children WHERE child_id=${profile.child_id}`;
      return !!child&&String(child.child_id)===String(profile.child_id);
    }
    const [[profile]]=await tx`SELECT phone10,child_id,admission_id FROM parent_profiles WHERE phone10=${phone10}`;
    if(!profile)return false;
    // Registration opens the chat before clinical matching is complete.
    // Media follows that same chat eligibility, while partial/stale links
    // still require a valid active admission.
    if(!String(profile.child_id||'').trim()&&!String(profile.admission_id||'').trim())return true;
    const [[admission]]=await tx`SELECT status FROM admissions WHERE admission_id=${profile.admission_id}`;
    return admission?.status==='active';
  }
  async function grantCookie(req,res,next) {
    try {
      const token=String(req.get('x-medsi-chat-session')||'');
      const auth=token?await sessions.verifyWorker(token):null;
      if(auth&&(auth.role==='educator'||(auth.role==='parent'&&PHONE.test(auth.phone10)))) {
        const exp=Math.min(Number(auth.exp||0),now()+MAX_COOKIE_AGE);
        if(exp>now()){
          const payload=Buffer.from(JSON.stringify({
            role:auth.role,phone10:auth.role==='parent'?auth.phone10:'',exp
          })).toString('base64url');
          const signature=createHmac('sha256',secret).update(payload).digest('base64url');
          res.cookie(COOKIE,payload+'.'+signature,{
            maxAge:Math.max(0,exp-now()),path:'/media',secure:true,httpOnly:true,
            sameSite:'strict',priority:'high'
          });
        }
      }
      next();
    }catch(_){next();}
  }
  async function authenticateRequest(req,phone10) {
    const auth=await sessions.verifyWorker(String(req.get('x-medsi-chat-session')||''));
    if(!auth||auth.preview||!['parent','educator'].includes(auth.role)||
      (auth.role==='parent'&&auth.phone10!==phone10))return null;
    const active=await read(tx=>activePhone(tx,phone10));
    return active?auth:null;
  }
  async function upload(req,res) {
    const phone10=String(req.get('x-medsi-phone')||'').replace(/\D/g,'').slice(-10);
    if(!PHONE.test(phone10)||!await authenticateRequest(req,phone10)){
      return res.status(401).json({ok:false,code:'UNAUTHORIZED'});
    }
    if(!storage.configured)return res.status(503).json({ok:false,code:'S3_NOT_CONFIGURED'});
    const length=Number(req.headers['content-length']);
    if(!Number.isSafeInteger(length)||length<=0)return res.status(411).json({ok:false,code:'UPLOAD_LENGTH_REQUIRED'});
    if(length>MAX_UPLOAD_BYTES)return res.status(413).json({ok:false,code:'FILE_TOO_LARGE'});
    const rawId=String(req.get('x-medsi-upload-id')||'');
    if(!UPLOAD_ID.test(rawId))return res.status(400).json({ok:false,code:'INVALID_UPLOAD_ID'});
    const scopedId=sha(phone10+'\0'+rawId);
    try{
      const result=await storage.uploadStream({
        body:req,contentType:String(req.get('content-type')||''),
        contentLength:length,fileName:String(req.get('x-file-name')||'attachment'),
        uploadId:scopedId
      });
      const fileId='s3:'+result.key;
      await write(async tx=>{
        const [[existing]]=await tx`SELECT phone10 FROM chat_media WHERE file_id=${fileId}`;
        if(existing&&existing.phone10!==phone10)throw new Error('Media owner conflict.');
        await tx.upsert`INSERT INTO chat_media (file_id,phone10,uploaded_at)
          VALUES (${fileId},${phone10},${uint(now())})`;
      });
      return res.json({ok:true,type:result.mediaType,fileId,
        url:'/media/s3/'+encodeURIComponent(result.key)});
    }catch(error){
      const invalid=error?.code==='UNSUPPORTED_MEDIA';
      return res.status(invalid?415:503).json({ok:false,
        code:invalid?'UNSUPPORTED_MEDIA':'UPLOAD_FAILED',
        message:invalid?'Допускаются только фото и видео.':'Не удалось загрузить файл.'});
    }
  }
  async function open(req,res) {
    const claims=parseClaims(cookieValue(req.headers.cookie),secret,now());
    const key=String(req.params.key||'');
    if(!claims||!isChatMediaKey(key)||!storage.configured)return res.status(404).end();
    const fileId='s3:'+key;
    const allowed=await read(async tx=>{
      const [messages]=await tx`SELECT phone10,status FROM chat_messages
        WHERE file_id=${fileId}`;
      const relevant=messages.filter(m=>m.status==='active'&&
        (claims.role==='educator'||m.phone10===claims.phone10));
      for(const row of relevant) {
        if(await activePhone(tx,row.phone10))return true;
      }
      return false;
    });
    if(!allowed)return res.status(404).end();
    try{
      const object=await storage.getObject(key,req.get('range')||undefined);
      if(object.ContentType)res.setHeader('content-type',object.ContentType);
      if(object.ContentDisposition)res.setHeader('content-disposition',object.ContentDisposition);
      if(object.ContentLength!=null)res.setHeader('content-length',String(object.ContentLength));
      if(object.ContentRange)res.setHeader('content-range',object.ContentRange);
      res.setHeader('cache-control','private, no-store');
      res.setHeader('accept-ranges',object.AcceptRanges||'bytes');
      res.setHeader('x-content-type-options','nosniff');
      res.status(object.ContentRange?206:200);
      if(object.Body&&typeof object.Body.pipe==='function'){
        object.Body.pipe(res);
      }else if(object.Body){
        res.end(Buffer.from(await object.Body.transformToByteArray()));
      }else res.end();
    }catch(error){
      const status=Number(error?.$metadata?.httpStatusCode||error?.statusCode);
      if(!res.headersSent)res.status(status===404?404:503).end();
    }
  }
  return {grantCookie,upload,open,parseMediaCookie:v=>parseClaims(cookieValue(v),secret,now())};
}
