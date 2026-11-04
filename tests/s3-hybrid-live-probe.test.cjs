'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startSmokeStand}=require('../services/s3-hybrid/stand-smoke.cjs');
const {runS3RoundTripProbe}=require('../services/s3-hybrid/live-probe.cjs');

const env={MEDSI_S3_HYBRID_STAND:'1',MEDSI_S3_PROBE_ENABLED:'1',
  S3_PROBE_BUCKET:'synthetic-test-bucket',
  S3_PROBE_ACCESS_KEY:'synthetic-access-key',
  S3_PROBE_SECRET_KEY:'synthetic-secret-key'};

test('live probe refuses missing credentials and live-bucket reuse',async()=>{
  assert.deepEqual(await runS3RoundTripProbe({...env,S3_PROBE_BUCKET:''}),
    {ok:false,code:'S3_PROBE_CONFIG_INVALID'});
  assert.deepEqual(await runS3RoundTripProbe({...env,S3_BUCKET:env.S3_PROBE_BUCKET}),
    {ok:false,code:'S3_PROBE_CONFIG_INVALID'});
});

test('S3 roundtrip verifies immutable writes, reading, listing and deletion',async()=>{
  const map=new Map();
  const client={send:async command=>{
    const name=command.constructor.name;
    const {Key,Prefix,Body,IfNoneMatch}=command.input;
    if(name==='GetObjectCommand'){
      if(!map.has(Key))throw {$metadata:{httpStatusCode:404}};
      return {Body:Buffer.from(map.get(Key))};
    }
    if(name==='PutObjectCommand'){
      if(IfNoneMatch==='*'&&map.has(Key))throw {$metadata:{httpStatusCode:412}};
      map.set(Key,Buffer.from(Body));
      return {};
    }
    if(name==='ListObjectsV2Command'){
      return {Contents:[...map.keys()].filter(key=>key.startsWith(Prefix))
        .map(Key=>({Key})),IsTruncated:false};
    }
    if(name==='DeleteObjectCommand'){map.delete(Key);return {};}
    throw Error('Unexpected command '+name);
  }};
  assert.deepEqual(await runS3RoundTripProbe(env,{client}),
    {ok:true,code:'S3_PROBE_OK'});
  assert.equal(map.size,0);
});

test('HTTP availability precedes optional S3 IO and failed health is sanitized',async()=>{
  let resolve;
  const gate=new Promise(r=>resolve=r);
  const server=startSmokeStand({...env,PORT:'0'},{probe:()=>gate});
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port;
  try{
    const root=await fetch(url+'/');
    assert.equal(root.status,200);
    let health=await fetch(url+'/__health');
    assert.equal(health.status,200);
    assert.equal((await health.json()).code,'S3_PROBE_PENDING');
    resolve({ok:false,code:'S3_PROBE_CONDITIONAL_UNSUPPORTED'});
    await new Promise(r=>setImmediate(r));
    health=await fetch(url+'/__health');
    assert.equal(health.status,503);
    const body=await health.json();
    assert.equal(body.code,'S3_PROBE_CONDITIONAL_UNSUPPORTED');
    assert.equal(body.ok,false);
    assert.equal(body.storage,'unavailable');
    assert.equal(JSON.stringify(body).includes('synthetic-secret-key'),false);
  }finally{
    resolve({ok:false});
    await new Promise(r=>server.close(r));
  }
});
