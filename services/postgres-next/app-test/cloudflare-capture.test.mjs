import test from 'node:test';
import assert from 'node:assert/strict';
import {captureFrozenCloudflareSources,D1_SOURCE_TABLES} from '../src/cloudflare-capture.mjs';

function fixture({drift=false,kvDrift=false,schemaExtra=false}={}){
  let batches=0,lists=0;
  const db={prepare:query=>({query,all:async()=>({success:true,results:[...D1_SOURCE_TABLES,...(schemaExtra?['unknown_table']:[])].map(name=>({name}))})}),
    batch:async queries=>{batches++;return queries.map(({query})=>({success:true,results:query.endsWith('chat_profiles')?[{phone10:'9000000001',version:drift?batches:1}]:[]}));}};
  const pushKV={list:async({cursor})=>{
    if(!cursor){lists++;return {keys:[{name:'sub:synthetic-a'}],cursor:'next',list_complete:false};}
    return {keys:[{name:'sub:synthetic-b'}],list_complete:true};
  },get:async name=>JSON.stringify({name,version:kvDrift?lists:1})};
  return {db,pushKV,freezeConfirmed:true};
}
test('frozen adapter reads every D1 table and paginated push values twice',async()=>{
  const result=await captureFrozenCloudflareSources(fixture());
  assert.equal(Object.keys(result.tables).length,D1_SOURCE_TABLES.length);
  assert.equal(result.pushEntries.length,2);
});
test('capture rejects changed D1, changed KV and unrecognized source tables',async()=>{
  for(const options of [{drift:true},{kvDrift:true},{schemaExtra:true}])
    await assert.rejects(()=>captureFrozenCloudflareSources(fixture(options)),/capture failed/);
});
test('capture requires explicit freeze and hides private provider failures',async()=>{
  await assert.rejects(()=>captureFrozenCloudflareSources({...fixture(),freezeConfirmed:false}),/required/);
  const env=fixture();env.pushKV.get=async()=>{throw new Error('private-endpoint-and-key');};
  await assert.rejects(()=>captureFrozenCloudflareSources(env),error=>!error.message.includes('private-endpoint'));
});
test('KV pagination that repeats a cursor is rejected',async()=>{
  const env=fixture();env.pushKV.list=async()=>({keys:[],cursor:'same',list_complete:false});
  await assert.rejects(()=>captureFrozenCloudflareSources(env),/capture failed/);
});
