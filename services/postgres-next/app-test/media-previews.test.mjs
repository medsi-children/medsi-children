import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {Readable} from 'node:stream';
import {createMediaPreviews} from '../app/media-previews.mjs';
test('large source produces a small rotated thumbnail and shares concurrent generation',async()=>{
  const source=await sharp({create:{width:3200,height:2400,channels:3,background:'#178f98'}}).jpeg().toBuffer();
  let reads=0;
  const load=async()=>{reads++;return {ContentType:'image/jpeg',ContentLength:source.length,Body:Readable.from([source])};};
  const preview=createMediaPreviews();
  const results=await Promise.all(Array.from({length:10},()=>preview('synthetic',load)));
  assert.equal(reads,1);
  const meta=await sharp(results[0]).metadata();
  assert.equal(meta.width,640);assert.equal(meta.height,480);
  assert.ok(results[0].length<source.length/4);
  assert.deepEqual(await preview('synthetic',load),results[0]);
  assert.equal(reads,1);
});
test('ten distinct previews queue at most two simultaneous original downloads',async()=>{
  const source=await sharp({create:{width:80,height:80,channels:3,background:'#abcdef'}}).jpeg().toBuffer();
  let active=0,peak=0;
  const preview=createMediaPreviews();
  await Promise.all(Array.from({length:10},(_,i)=>preview('synthetic-'+i,async()=>{
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,5));active--;
    return {ContentType:'image/jpeg',ContentLength:source.length,Body:Readable.from([source])};
  })));
  assert.equal(peak,2);
});
test('oversized and corrupt sources fail without poisoning retries',async()=>{
  const preview=createMediaPreviews();
  await assert.rejects(preview('bad',async()=>({ContentType:'image/jpeg',ContentLength:26*1024*1024})));
  await assert.rejects(preview('bad',async()=>({ContentType:'image/jpeg',Body:Readable.from([Buffer.from('invalid')])})));
});
