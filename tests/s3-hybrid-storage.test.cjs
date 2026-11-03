'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createObjectStore}=require('../services/s3-hybrid/object-store.cjs');
const {createS3ChatStore}=require('../services/s3-hybrid/chat-store.cjs');
const {createS3ReportStore}=require('../services/s3-hybrid/report-store.cjs');

function fakeS3(){
  const data=new Map();
  let puts=0, failAt=0, failUnsupported=false;
  const client={async send(command){
    const type=command.constructor.name;
    const {Key,Prefix,ContinuationToken,MaxKeys,Body,IfNoneMatch}=command.input;
    if(type==='PutObjectCommand'){
      puts++;
      if(failAt&&puts===failAt)throw new Error('Synthetic S3 network outage');
      if(failUnsupported){
        const e=new Error('Not implemented');
        e.name='NotImplemented';e.$metadata={httpStatusCode:501};throw e;
      }
      if(IfNoneMatch!=='*')throw new Error('Unsafe mutable S3 write');
      if(data.has(Key)){
        const e=new Error('Precondition failed');
        e.name='PreconditionFailed';e.$metadata={httpStatusCode:412};throw e;
      }
      data.set(Key,Buffer.from(Body));
      return {ETag:'"synthetic"'};
    }
    if(type==='GetObjectCommand'){
      if(!data.has(Key)){
        const e=new Error('Missing');e.name='NoSuchKey';
        e.$metadata={httpStatusCode:404};throw e;
      }
      return {Body:data.get(Key)};
    }
    if(type==='ListObjectsV2Command'){
      const keys=[...data.keys()].filter(k=>k.startsWith(Prefix)).sort();
      const start=Number(ContinuationToken||0);
      const size=Number(MaxKeys||1000);
      const slice=keys.slice(start,start+size);
      return {
        Contents:slice.map(Key=>({Key})),
        IsTruncated:start+size<keys.length,
        NextContinuationToken:start+size<keys.length?String(start+size):undefined
      };
    }
    if(type==='DeleteObjectCommand'){data.delete(Key);return {};}
    throw new Error('Unrecognized test command: '+type);
  }};
  return {
    client,data,
    get puts(){return puts;},
    failAfter(extra){failAt=puts+extra;},
    clearFailure(){failAt=0;},
    setUnsupported(v){failUnsupported=Boolean(v);}
  };
}
function setup(){
  const fake=fakeS3();
  return {...fake,objects:createObjectStore({
    client:fake.client,bucket:'synthetic-bucket',prefix:'medsi-hybrid/v1'
  })};
}
const TIMESTAMP=Date.parse('2026-11-04T12:00:00Z');
const T='test_thread_abcdefghijklmn';
const P='parent_abcdefghijklmnop';
const E='educator_abcdefghijkl';
const MID='message_abcdefghijkl';
const MID2='message_bcdefghijklmn';
const EVT='event_abcdefghijklmn';

test('S3 adapter enforces conditional immutable puts, bounds, pagination and conflict',async()=>{
  const {objects,data}=setup();
  assert.equal(await objects.getJson('demo/a.json'),null);
  assert.deepEqual(await objects.putOnce('demo/a.json',{a:1}),{created:true});
  assert.deepEqual(await objects.putOnce('demo/a.json',{a:1}),{created:false});
  await assert.rejects(objects.putOnce('demo/a.json',{a:2}),/IMMUTABLE_CONFLICT/);
  assert.equal((await objects.getJson('demo/a.json')).a,1);
  await objects.putOnce('demo/b.json',{a:2});
  await objects.putOnce('demo/c.json',{a:3});
  assert.deepEqual(await objects.listJsonKeys('demo/',{limit:3}),
    ['demo/a.json','demo/b.json','demo/c.json']);
  await assert.rejects(objects.listJsonKeys('demo/',{limit:2}),/SCAN_LIMIT/);
  await assert.rejects(objects.getJson('../secrets.json'),/INVALID_KEY/);
  assert.equal(data.size,3);
  await objects.remove('demo/b.json');
  assert.equal(await objects.getJson('demo/b.json'),null);
});

test('conditional-put incompatibility fails closed rather than silently overwriting',async()=>{
  const ctx=setup();ctx.setUnsupported(true);
  await assert.rejects(ctx.objects.putOnce('demo/a.json',{a:1}),
    /CONDITIONAL_PUT_UNSUPPORTED/);
  assert.equal(ctx.data.size,0);
});

test('two simultaneous messages stay independent; network retries are idempotent',async()=>{
  const {objects,data}=setup();
  let time=TIMESTAMP;
  const chat=createS3ChatStore({objects,now:()=>++time});
  const a={threadId:T,messageId:MID,actorId:P,actorRole:'parent',text:'Привет'};
  const b={threadId:T,messageId:MID2,actorId:E,actorRole:'educator',text:'Здравствуйте'};
  const saved=await Promise.all([chat.send(a),chat.send(b)]);
  assert(saved.every(x=>x.created));
  const thread=await chat.listThread({threadId:T});
  assert.equal(thread.total,2);
  assert.deepEqual(thread.messages.map(x=>x.text),['Привет','Здравствуйте']);
  const duplicate=await chat.send(a);
  assert.equal(duplicate.created,false);
  await assert.rejects(chat.send({...a,text:'Другой текст'}),/DUPLICATE_ID_CONFLICT/);
  assert.equal(data.size,2);
});

test('edit, delete, reaction and read-cursor events rebuild chat without overwrites',async()=>{
  const {objects}=setup();
  let time=TIMESTAMP;
  const chat=createS3ChatStore({objects,now:()=>++time});
  await chat.send({threadId:T,messageId:MID,actorId:P,actorRole:'parent',text:'Начало'});
  await chat.send({threadId:T,messageId:MID2,actorId:E,actorRole:'educator',text:'Ответ'});
  await chat.mutate({threadId:T,eventId:EVT,messageId:MID,actorId:P,
    actorRole:'parent',action:'edit',text:'Исправлено'});
  await chat.mutate({threadId:T,eventId:'event_reaction_abcdef',messageId:MID,
    actorId:E,actorRole:'educator',action:'reaction',reaction:'❤',enabled:true});
  await chat.markRead({threadId:T,eventId:'event_read_abcdefghi',
    upToMessageId:MID,actorId:E,actorRole:'educator'});
  const result=await chat.listThread({threadId:T});
  assert.equal(result.messages[0].text,'Исправлено');
  assert.equal(result.messages[0].reactions[E],'❤');
  assert.equal(result.readCursors['educator:'+E].id,MID);
  await assert.rejects(chat.mutate({threadId:T,eventId:'event_bad_author_ab',
    messageId:MID,actorId:E,actorRole:'educator',action:'delete'}),/FORBIDDEN/);
  await chat.mutate({threadId:T,eventId:'event_delete_abcdefg',
    messageId:MID,actorId:P,actorRole:'parent',action:'delete'});
  const after=await chat.listThread({threadId:T});
  assert.equal(after.messages[0].deleted,true);
  assert.equal(after.messages[0].text,'');
});

test('report batch is invisible until commit manifest exists; retry completes it',async()=>{
  const f=setup();
  const reports=createS3ReportStore({objects:f.objects,now:()=>TIMESTAMP});
  const publication={
    kind:'morning',date:'2026-11-04',revision:1,
    publicationId:'publication_abcdefghijkl',reports:[
      {familyId:'family_abcdefghijkl',text:'Утро ребёнка А'},
      {familyId:'family_bcdefghijklmn',text:'Утро ребёнка Б'}
    ]
  };
  f.failAfter(2);
  await assert.rejects(reports.publish(publication),/Synthetic S3 network outage/);
  assert.deepEqual(await reports.listFamily({familyId:'family_abcdefghijkl',at:TIMESTAMP}),[]);
  f.clearFailure();
  const done=await reports.publish(publication);
  assert.equal(done.committed,true);
  assert.equal(done.recipients,2);
  assert.equal((await reports.listFamily({
    familyId:'family_abcdefghijkl',at:TIMESTAMP
  }))[0].text,'Утро ребёнка А');
  const repeat=await reports.publish(publication);
  assert.equal(repeat.reused,true);
});

test('report history keeps highest revision per day and only last seven dates',async()=>{
  const {objects}=setup();
  const reports=createS3ReportStore({objects,now:()=>TIMESTAMP,days:7});
  const familyId='family_abcdefghijkl';
  const make=(date,rev,pub,text)=>reports.publish({
    kind:'evening',date,revision:rev,publicationId:pub,
    reports:[{familyId,text}]
  });
  await make('2026-10-27',1,'publication_old_abcdefgh','Too old');
  await make('2026-11-03',1,'publication_one_abcdefgh','First revision');
  await make('2026-11-03',2,'publication_two_abcdefgh','Latest revision');
  await make('2026-11-04',3,'publication_three_abcdef','Today');
  const history=await reports.listFamily({familyId,at:TIMESTAMP});
  assert.deepEqual(history.map(x=>x.text),['Today','Latest revision']);
  await assert.rejects(reports.publish({
    kind:'evening',date:'2026-11-04',revision:4,
    publicationId:'publication_three_abcdef',
    reports:[{familyId,text:'Changed after commit'}]
  }),/IMMUTABLE_CONFLICT|PUBLICATION_CONFLICT/);
});

test('invalid report recipients fail before S3 writes',async()=>{
  const ctx=setup();
  const reports=createS3ReportStore({objects:ctx.objects});
  await assert.rejects(reports.publish({
    kind:'morning',date:'2026-11-04',revision:1,
    publicationId:'pub_abcdefghijklmnop',reports:[
      {familyId:'family_abcdefghijkl',text:'A'},
      {familyId:'family_abcdefghijkl',text:'B'}
    ]
  }),/DUPLICATE_FAMILY/);
  assert.equal(ctx.data.size,0);
});
