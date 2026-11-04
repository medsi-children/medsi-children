'use strict';

// Isolated API for exercising the S3 stores with synthetic families only.
// This is not a replacement for the production parent/educator APIs.
const crypto=require('node:crypto');
const {createS3ChatStore}=require('./chat-store.cjs');
const {createS3ReportStore}=require('./report-store.cjs');

const FAMILIES=new Set(['family-a','family-b']);
const TOKEN_ROLES=Object.freeze({
  educator:{role:'educator',familyId:null,env:'S3_STAND_EDUCATOR_TOKEN'},
  parentA:{role:'parent',familyId:'family-a',env:'S3_STAND_PARENT_A_TOKEN'},
  parentB:{role:'parent',familyId:'family-b',env:'S3_STAND_PARENT_B_TOKEN'}
});
const MAX_BODY=64*1024;

function tokenFor(request,env){
  const value=String(request.headers.authorization||'');
  const match=/^Bearer ([a-f0-9]{64})$/.exec(value);
  if(!match)return null;
  const supplied=Buffer.from(match[1]);
  for(const spec of Object.values(TOKEN_ROLES)){
    const expected=String(env[spec.env]||'');
    if(!/^[a-f0-9]{64}$/.test(expected))continue;
    const candidate=Buffer.from(expected);
    if(candidate.length===supplied.length&&crypto.timingSafeEqual(candidate,supplied))
      return spec;
  }
  return null;
}

function canAccess(actor,familyId){
  return FAMILIES.has(familyId)&&
    (actor.role==='educator'||actor.familyId===familyId);
}

async function readBody(request){
  const chunks=[];let size=0;
  for await(const chunk of request){
    size+=chunk.length;
    if(size>MAX_BODY)throw Object.assign(new Error('BODY_TOO_LARGE'),{status:413});
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch(_){throw Object.assign(new Error('INVALID_JSON'),{status:400});}
}

function createTestApi({objects,env=process.env,now=()=>Date.now()}={}){
  if(!objects?.getJson||!objects?.putOnce||!objects?.listJsonKeys||!objects?.remove)
    throw new Error('S3_TEST_API_INVALID_STORE');
  const chats=createS3ChatStore({objects,now});
  const reports=createS3ReportStore({objects,now});
  const json=(response,status,payload)=>{
    response.writeHead(status,{'content-type':'application/json; charset=utf-8'});
    response.end(JSON.stringify(payload));
  };
  const requireActor=(request,response)=>{
    const actor=tokenFor(request,env);
    if(!actor){json(response,401,{ok:false,code:'UNAUTHORIZED'});return null;}
    return actor;
  };
  const cleanPrefix=async prefix=>{
    const keys=await objects.listJsonKeys(prefix,{limit:1000});
    for(const key of keys)await objects.remove(key);
  };
  async function handle(request,response){
    if(env.MEDSI_S3_HYBRID_STAND!=='1'||env.MEDSI_S3_E2E_API_ENABLED!=='1')
      return json(response,404,{ok:false,code:'NOT_FOUND'});
    const url=new URL(request.url,'http://localhost');
    if(url.pathname==='/api/test/chat'&&request.method==='POST'){
      const actor=requireActor(request,response);if(!actor)return;
      const body=await readBody(request),familyId=String(body.familyId||'');
      if(!canAccess(actor,familyId))return json(response,403,{ok:false,code:'FORBIDDEN'});
      if(actor.role==='parent'&&body.actorRole&&body.actorRole!=='parent')
        return json(response,403,{ok:false,code:'FORBIDDEN'});
      const result=await chats.send({threadId:familyId,messageId:body.messageId,
        actorId:actor.role==='educator'?'educator-demo':actor.familyId,
        actorRole:actor.role,text:body.text,replyTo:body.replyTo||''});
      return json(response,result.created?201:200,{ok:true,message:result.record});
    }
    if(url.pathname==='/api/test/chat'&&request.method==='GET'){
      const actor=requireActor(request,response);if(!actor)return;
      const familyId=String(url.searchParams.get('familyId')||'');
      if(!canAccess(actor,familyId))return json(response,403,{ok:false,code:'FORBIDDEN'});
      return json(response,200,{ok:true,...await chats.listThread({threadId:familyId,limit:100})});
    }
    if(url.pathname==='/api/test/reports'&&request.method==='POST'){
      const actor=requireActor(request,response);if(!actor)return;
      if(actor.role!=='educator')return json(response,403,{ok:false,code:'FORBIDDEN'});
      const body=await readBody(request);
      if(!Array.isArray(body.reports)||body.reports.some(x=>!FAMILIES.has(String(x?.familyId||''))))
        return json(response,400,{ok:false,code:'INVALID_TEST_FAMILIES'});
      const result=await reports.publish({kind:body.kind,date:body.date,
        revision:body.revision,publicationId:body.publicationId,
        sourceFingerprint:'synthetic-test',reports:body.reports});
      return json(response,201,{ok:true,...result});
    }
    if(url.pathname==='/api/test/reports'&&request.method==='GET'){
      const actor=requireActor(request,response);if(!actor)return;
      const familyId=String(url.searchParams.get('familyId')||'');
      if(!canAccess(actor,familyId))return json(response,403,{ok:false,code:'FORBIDDEN'});
      return json(response,200,{ok:true,reports:await reports.listFamily({familyId})});
    }
    if(url.pathname==='/api/test/cleanup'&&request.method==='POST'){
      const actor=requireActor(request,response);if(!actor)return;
      if(actor.role!=='educator')return json(response,403,{ok:false,code:'FORBIDDEN'});
      for(const familyId of FAMILIES){
        await cleanPrefix('chats/'+familyId+'/messages/');
        await cleanPrefix('chats/'+familyId+'/events/');
      }
      // Test publications are identified by their synthetic fingerprint and
      // contain only the two fixed fake-family IDs. No production data is read.
      for(const kind of ['morning','evening','psychology']){
        const keys=await objects.listJsonKeys('reports/commits/'+kind+'/',{limit:1000});
        for(const key of keys){
          const manifest=await objects.getJson(key);
          if(manifest?.sourceFingerprint==='synthetic-test'&&
             Array.isArray(manifest.families)&&manifest.families.every(x=>FAMILIES.has(x))){
            await cleanPrefix('reports/items/'+String(manifest.publicationId)+'/');
            await objects.remove(key);
          }
        }
      }
      return json(response,200,{ok:true,cleaned:true});
    }
    return json(response,404,{ok:false,code:'NOT_FOUND'});
  }
  return {handle};
}

async function runSyntheticE2E({baseUrl,env=process.env,fetchImpl=fetch,
  now=()=>new Date()}={}){
  const token=name=>String(env[name]||'');
  const educator=token('S3_STAND_EDUCATOR_TOKEN');
  const parentA=token('S3_STAND_PARENT_A_TOKEN');
  const parentB=token('S3_STAND_PARENT_B_TOKEN');
  if(!baseUrl||[educator,parentA,parentB].some(x=>!/^[a-f0-9]{64}$/.test(x)))
    throw new Error('S3_E2E_CONFIG_INVALID');
  const request=async(path,{method='GET',authToken='',body}={})=>{
    let response;
    try{
      response=await fetchImpl(new URL(path,baseUrl),{
        method,headers:{...(authToken?{authorization:'Bearer '+authToken}:{}),
          ...(body?{'content-type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{})
      });
    }catch(_){throw new Error('S3_E2E_HTTP_FAILED');}
    let result;
    try{result=await response.json();}catch(_){throw new Error('S3_E2E_BAD_RESPONSE');}
    return {status:response.status,body:result};
  };
  const expect=(response,status,code)=>{
    if(response.status!==status||response.body?.ok!==(status<400))
      throw new Error(code);
    return response.body;
  };
  const publicationId='e2e_'+crypto.randomUUID().replace(/-/g,'');
  const messageId='e2e_'+crypto.randomUUID().replace(/-/g,'');
  const date=now().toISOString().slice(0,10);
  let finished=false;
  try{
    expect(await request('/api/test/chat?familyId=family-a'),401,'S3_E2E_AUTH_REQUIRED_FAILED');
    expect(await request('/api/test/chat',{method:'POST',authToken:parentA,
      body:{familyId:'family-a',messageId,text:'Synthetic test message for family A'}}),
      201,'S3_E2E_PARENT_MESSAGE_FAILED');
    const ownMessages=expect(await request('/api/test/chat?familyId=family-a',
      {authToken:parentA}),200,'S3_E2E_PARENT_CHAT_READ_FAILED');
    if(!ownMessages.messages?.some(x=>x.id===messageId&&x.text==='Synthetic test message for family A'))
      throw new Error('S3_E2E_PARENT_CHAT_MISMATCH');
    expect(await request('/api/test/chat?familyId=family-b',{authToken:parentA}),
      403,'S3_E2E_CROSS_FAMILY_CHAT_ACCESS');
    expect(await request('/api/test/reports',{method:'POST',authToken:parentA,
      body:{kind:'morning',date,revision:1,publicationId,
        reports:[{familyId:'family-a',text:'Synthetic morning report for family A'}]}}),
      403,'S3_E2E_PARENT_PUBLISH_ALLOWED');
    const published=expect(await request('/api/test/reports',{method:'POST',authToken:educator,
      body:{kind:'morning',date,revision:1,publicationId,reports:[
        {familyId:'family-a',text:'Synthetic morning report for family A'},
        {familyId:'family-b',text:'Synthetic morning report for family B'}
      ]}}),201,'S3_E2E_EDUCATOR_PUBLISH_FAILED');
    if(published.recipients!==2)throw new Error('S3_E2E_RECIPIENT_COUNT_MISMATCH');
    const reportA=expect(await request('/api/test/reports?familyId=family-a',
      {authToken:parentA}),200,'S3_E2E_PARENT_REPORT_READ_FAILED');
    if(!reportA.reports?.some(x=>x.publicationId===publicationId&&
        x.text==='Synthetic morning report for family A'))
      throw new Error('S3_E2E_PARENT_REPORT_MISMATCH');
    expect(await request('/api/test/reports?familyId=family-b',{authToken:parentA}),
      403,'S3_E2E_CROSS_FAMILY_REPORT_ACCESS');
    const reportB=expect(await request('/api/test/reports?familyId=family-b',
      {authToken:parentB}),200,'S3_E2E_SECOND_FAMILY_READ_FAILED');
    if(!reportB.reports?.some(x=>x.publicationId===publicationId&&
        x.text==='Synthetic morning report for family B'))
      throw new Error('S3_E2E_SECOND_FAMILY_MISMATCH');
    expect(await request('/api/test/cleanup',{method:'POST',authToken:parentA}),
      403,'S3_E2E_PARENT_CLEANUP_ALLOWED');
    expect(await request('/api/test/cleanup',{method:'POST',authToken:educator}),
      200,'S3_E2E_CLEANUP_FAILED');
    const after=expect(await request('/api/test/chat?familyId=family-a',
      {authToken:parentA}),200,'S3_E2E_POST_CLEANUP_CHAT_FAILED');
    if(after.total!==0)throw new Error('S3_E2E_CLEANUP_LEFT_MESSAGES');
    finished=true;
    return {ok:true,code:'S3_E2E_OK'};
  }finally{
    if(!finished){try{await request('/api/test/cleanup',{method:'POST',authToken:educator});}catch(_){}}
  }
}

module.exports={createTestApi,runSyntheticE2E,FAMILIES,TOKEN_ROLES};
