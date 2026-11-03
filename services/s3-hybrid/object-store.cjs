'use strict';
// Standalone S3 persistence adapter. No production wiring, credentials,
// patient information or network activity at import time.
const {
  PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand
}=require('@aws-sdk/client-s3');

const KEY_PART=/^[a-zA-Z0-9_-]{1,96}$/;
const PREFIX=/^[a-zA-Z0-9/_-]{1,120}$/;
const JSON_LIMIT=1024*1024;

function objectKey(prefix,relative){
  if(typeof relative!=='string'||relative.length>600||
      !/^[a-zA-Z0-9/_-]+\.json$/.test(relative)||
      relative.includes('//')||relative.includes('..')||
      relative.split('/').some(x=>!x))throw new Error('S3_HYBRID_INVALID_KEY');
  return prefix+'/'+relative;
}
function isMissing(e){
  return e?.$metadata?.httpStatusCode===404||
    e?.name==='NoSuchKey'||e?.name==='NotFound';
}
function isPrecondition(e){
  return e?.$metadata?.httpStatusCode===412||
    e?.name==='PreconditionFailed';
}
function isUnsupportedCondition(e){
  const s=e?.$metadata?.httpStatusCode;
  return s===501||e?.name==='NotImplemented';
}
async function bodyToBuffer(body){
  if(!body)throw new Error('S3_HYBRID_EMPTY_OBJECT');
  const chunks=[];let size=0;
  if(typeof body[Symbol.asyncIterator]==='function'){
    for await(const chunk of body){
      const b=Buffer.from(chunk);
      size+=b.length;
      if(size>JSON_LIMIT)throw new Error('S3_HYBRID_OBJECT_TOO_LARGE');
      chunks.push(b);
    }
  }else if(typeof body.transformToByteArray==='function'){
    const bytes=Buffer.from(await body.transformToByteArray());
    if(bytes.length>JSON_LIMIT)throw new Error('S3_HYBRID_OBJECT_TOO_LARGE');
    chunks.push(bytes);
  }else if(Buffer.isBuffer(body)||typeof body==='string'){
    const b=Buffer.from(body);
    if(b.length>JSON_LIMIT)throw new Error('S3_HYBRID_OBJECT_TOO_LARGE');
    chunks.push(b);
  }else throw new Error('S3_HYBRID_UNREADABLE_OBJECT');
  return Buffer.concat(chunks);
}
function createObjectStore({client,bucket,prefix='medsi-hybrid/v1'}={}){
  if(!client||typeof client.send!=='function'||typeof bucket!=='string'||!bucket.trim()||
      typeof prefix!=='string'||!PREFIX.test(prefix)||prefix.includes('..')||
      prefix.startsWith('/')||prefix.endsWith('/')){
    throw new Error('S3_HYBRID_INVALID_STORE');
  }
  const key=relative=>objectKey(prefix,relative);
  async function getJson(relative){
    let obj;
    try{obj=await client.send(new GetObjectCommand({Bucket:bucket,Key:key(relative)}));}
    catch(error){if(isMissing(error))return null;throw error;}
    const bytes=await bodyToBuffer(obj.Body);
    try{return JSON.parse(bytes.toString('utf8'));}
    catch(_){throw new Error('S3_HYBRID_INVALID_JSON');}
  }
  async function putOnce(relative,data){
    const json=JSON.stringify(data);
    if(typeof json!=='string')throw new Error('S3_HYBRID_INVALID_JSON');
    const bytes=Buffer.from(json,'utf8');
    if(bytes.length>JSON_LIMIT)throw new Error('S3_HYBRID_OBJECT_TOO_LARGE');
    try{
      await client.send(new PutObjectCommand({
        Bucket:bucket,Key:key(relative),Body:bytes,
        ContentType:'application/json; charset=utf-8',
        CacheControl:'no-store',
        // Critical: retries must not overwrite an already committed message.
        IfNoneMatch:'*'
      }));
      return {created:true};
    }catch(error){
      if(isPrecondition(error)){
        const old=await getJson(relative);
        if(old!==null&&JSON.stringify(old)===json)return {created:false};
        throw new Error('S3_HYBRID_IMMUTABLE_CONFLICT');
      }
      if(isUnsupportedCondition(error)){
        throw new Error('S3_HYBRID_CONDITIONAL_PUT_UNSUPPORTED');
      }
      throw error;
    }
  }
  async function listJsonKeys(relativePrefix,{limit=4000}={}){
    if(!Number.isInteger(limit)||limit<1||limit>10000)
      throw new Error('S3_HYBRID_INVALID_LIMIT');
    // Keys are never built from phone numbers or parent/child names.
    if(typeof relativePrefix!=='string'||relativePrefix.length>550||
       !/^[a-zA-Z0-9/_-]+\/$/.test(relativePrefix)||
       relativePrefix.includes('//')||relativePrefix.includes('..'))
      throw new Error('S3_HYBRID_INVALID_PREFIX');
    const out=[];let token;const seen=new Set();
    do{
      const page=await client.send(new ListObjectsV2Command({
        Bucket:bucket,Prefix:prefix+'/'+relativePrefix,
        MaxKeys:Math.min(1000,limit-out.length+1),
        ...(token?{ContinuationToken:token}:{})
      }));
      for(const item of page.Contents||[]){
        const full=String(item.Key||'');
        if(full.startsWith(prefix+'/')&&full.endsWith('.json'))
          out.push(full.slice(prefix.length+1));
        if(out.length>limit)throw new Error('S3_HYBRID_SCAN_LIMIT');
      }
      if(!page.IsTruncated)break;
      const next=String(page.NextContinuationToken||'');
      if(!next||seen.has(next))throw new Error('S3_HYBRID_BAD_PAGINATION');
      seen.add(next);token=next;
    }while(true);
    return out.sort();
  }
  async function remove(relative){
    await client.send(new DeleteObjectCommand({Bucket:bucket,Key:key(relative)}));
  }
  return {getJson,putOnce,listJsonKeys,remove};
}
module.exports={createObjectStore,KEY_PART};
