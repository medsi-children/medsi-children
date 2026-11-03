import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaService} from '../src/media-service.mjs';

const key='chat/'+'b'.repeat(64)+'.jpg', phone='9991112233', other='9994445566';
function harness() {
  const state={media:new Map(),messages:new Map(),reads:0};
  const sql={begin:async(_opts,fn)=>fn(async(strings,...values)=>{
    const query=strings.join('?').replace(/\s+/g,' ');
    if(query.includes('FROM parent_profiles'))return [[{phone10:values[0],admission_id:'adm'}]];
    if(query.includes('FROM admissions'))return [[{status:'active'}]];
    if(query.includes('FROM chat_media')){
      const row=state.media.get(values[0]);
      return [row?[row]:[]];
    }
    if(query.includes('FROM chat_messages VIEW chat_messages_by_file')){
      return [state.messages.get(values[0])||[]];
    }
    if(query.includes('UPSERT INTO chat_media')){
      state.media.set(values[0],{file_id:values[0],phone10:values[1]});
      return [];
    }
    throw Error('Unexpected test query');
  })};
  const storage={configured:true,uploadStream:async()=>({key,mediaType:'image'}),
    getObject:async()=>{state.reads++;return {ContentType:'image/jpeg',
      ContentLength:3,Body:{transformToByteArray:async()=>new Uint8Array([1,2,3])}}}};
  const sessions={verifyWorker:async token=>{
    if(token==='parent')return {role:'parent',phone10:phone,exp:Date.now()+600000};
    if(token==='educator')return {role:'educator',phone10:'',exp:Date.now()+600000};
    return null;
  }};
  const service=createMediaService({sql,storage,sessions,secret:'m'.repeat(64)});
  const response=()=>{
    const res={headers:{},statusCode:200,cookies:[],body:null,
      cookie(name,value,options){this.cookies.push({name,value,options});return this;},
      status(code){this.statusCode=code;return this;},
      json(body){this.body=body;return this;},
      end(body){this.body=body;return this;},
      setHeader(name,value){this.headers[name]=value;return this;}};
    return res;
  };
  return {service,state,response};
}
test('S3 upload binds file identifier to verified active parent phone',async()=>{
  const {service,state,response}=harness();
  const headers={'x-medsi-phone':'8'+phone,'x-medsi-chat-session':'parent',
    'x-medsi-upload-id':'random-id-0000000001','content-type':'image/jpeg',
    'x-file-name':'test.jpg'};
  const req={headers:{'content-length':'123'},get:k=>headers[k.toLowerCase()]};
  const res=response();
  await service.upload(req,res);
  assert.equal(res.body.ok,true);
  assert.equal(state.media.get('s3:'+key).phone10,phone);
  assert.equal(res.body.fileId,'s3:'+key);
  const denied=response();
  await service.upload({...req,get:k=>k==='x-medsi-chat-session'?'invalid':req.get(k)},denied);
  assert.equal(denied.statusCode,401);
  assert.equal(denied.body.ok,false);
});
test('media cookies are HttpOnly and cannot reveal another parent chat',async()=>{
  const {service,state,response}=harness();
  const headers={'x-medsi-chat-session':'parent'};
  const issued=response();
  await service.grantCookie({get:k=>headers[k.toLowerCase()]},issued,()=>{});
  const item=issued.cookies[0];
  assert.equal(item.name,'medsi_media_session');
  assert.equal(item.options.httpOnly,true);
  assert.equal(item.options.secure,true);
  assert.equal(item.options.sameSite,'strict');
  assert.equal(service.parseMediaCookie(item.name+'='+item.value).phone10,phone);
  const read=async()=>{const res=response();await service.open({
    params:{key},headers:{cookie:item.name+'='+item.value},get:()=>''},res);return res};
  state.messages.set('s3:'+key,[{phone10:other,status:'active'}]);
  let result=await read();
  assert.equal(result.statusCode,404);
  assert.equal(state.reads,0);
  state.messages.set('s3:'+key,[{phone10:phone,status:'active'}]);
  result=await read();
  assert.equal(result.statusCode,200);
  assert.deepEqual([...result.body],[1,2,3]);
  assert.equal(result.headers['cache-control'],'private, no-store');
});
