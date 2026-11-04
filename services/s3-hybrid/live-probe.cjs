'use strict';
// Explicitly opt-in test-bucket-only probe: never use patient objects or
// the regular S3_BUCKET. Return only a fixed public code, never SDK errors.
const crypto=require('node:crypto');
const {S3Client}=require('@aws-sdk/client-s3');
const {createObjectStore}=require('./object-store.cjs');

async function runS3RoundTripProbe(env=process.env,{client=null}={}){
  const bucket=String(env.S3_PROBE_BUCKET||'').trim();
  const accessKeyId=String(env.S3_PROBE_ACCESS_KEY||'').trim();
  const secretAccessKey=String(env.S3_PROBE_SECRET_KEY||'').trim();
  if(env.MEDSI_S3_HYBRID_STAND!=='1'||env.MEDSI_S3_PROBE_ENABLED!=='1'||
     !bucket||!accessKeyId||!secretAccessKey||
     bucket===String(env.S3_BUCKET||'').trim()){
    return {ok:false,code:'S3_PROBE_CONFIG_INVALID'};
  }
  const ownedClient=!client;
  const s3=client||new S3Client({
    endpoint:String(env.S3_PROBE_ENDPOINT||'https://s3.twcstorage.ru').replace(/\/$/,''),
    region:String(env.S3_PROBE_REGION||'ru-1'),
    forcePathStyle:true,credentials:{accessKeyId,secretAccessKey},
    maxAttempts:2
  });
  const nonce=crypto.randomUUID();
  const store=createObjectStore({
    client:s3,bucket,prefix:'medsi-s3-probe/v1/'+nonce
  });
  const key='checks/roundtrip.json';
  const payload={kind:'synthetic-smoke',nonce,revision:1};
  let created=false;
  try{
    const first=await store.getJson(key);
    if(first!==null)return {ok:false,code:'S3_PROBE_NAMESPACE_COLLISION'};
    const written=await store.putOnce(key,payload);
    created=true;
    if(!written.created)return {ok:false,code:'S3_PROBE_WRITE_FAILED'};
    const read=await store.getJson(key);
    if(JSON.stringify(read)!==JSON.stringify(payload))
      return {ok:false,code:'S3_PROBE_READ_MISMATCH'};
    const duplicate=await store.putOnce(key,payload);
    if(duplicate.created)return {ok:false,code:'S3_PROBE_IDEMPOTENCY_FAILED'};
    let guarded=false;
    try{await store.putOnce(key,{...payload,revision:2});}
    catch(error){
      if(error?.message==='S3_HYBRID_CONDITIONAL_PUT_UNSUPPORTED')
        return {ok:false,code:'S3_PROBE_CONDITIONAL_UNSUPPORTED'};
      if(error?.message==='S3_HYBRID_IMMUTABLE_CONFLICT')guarded=true;
      else throw error;
    }
    if(!guarded)return {ok:false,code:'S3_PROBE_OVERWRITE_UNSAFE'};
    const keys=await store.listJsonKeys('checks/',{limit:10});
    if(!keys.includes(key))return {ok:false,code:'S3_PROBE_LIST_FAILED'};
    await store.remove(key);
    created=false;
    if(await store.getJson(key)!==null)return {ok:false,code:'S3_PROBE_DELETE_FAILED'};
    return {ok:true,code:'S3_PROBE_OK'};
  }catch(_){
    return {ok:false,code:'S3_PROBE_IO_FAILED'};
  }finally{
    if(created){try{await store.remove(key);}catch(_){}}
    if(ownedClient)s3.destroy();
  }
}
module.exports={runS3RoundTripProbe};
