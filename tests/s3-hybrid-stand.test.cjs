'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {startSmokeStand}=require('../services/s3-hybrid/stand-smoke.cjs');

test('isolated S3 hybrid stand responds without credentials or patient services',async()=>{
  const server=startSmokeStand({MEDSI_S3_HYBRID_STAND:'1',PORT:'0'});
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const root=await fetch(base+'/');
    assert.equal(root.status,200);
    assert.match(await root.text(),/No patient data connected/);
    const health=await fetch(base+'/__health');
    assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{
      ok:true,service:'medsi-s3-hybrid-smoke',mode:'isolated',
      stage:'runtime-only',storage:'not-connected'
    });
    const missing=await fetch(base+'/private');
    assert.equal(missing.status,404);
  }finally{
    await new Promise(resolve=>server.close(resolve));
  }
});

test('isolated S3 hybrid stand cannot be enabled accidentally',()=>{
  assert.throws(()=>startSmokeStand({PORT:'0'}),/NOT_ENABLED/);
  assert.throws(()=>startSmokeStand({MEDSI_S3_HYBRID_STAND:'1',PORT:'invalid'}),/INVALID_PORT/);
});
