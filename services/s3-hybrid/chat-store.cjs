'use strict';
// Append-only S3 chat prototype. Each message/event has its own immutable
// object. User identities and authorization MUST be verified by the Timeweb
// API before any method is called; this library never accepts web requests.
const {KEY_PART}=require('./object-store.cjs');
const ROLES=new Set(['parent','educator']);
const MSG=/^[a-zA-Z0-9_-]{12,96}$/;
const MAX_TEXT=12000;
function ident(v,label,pattern=KEY_PART){
  if(typeof v!=='string'||!pattern.test(v))
    throw new Error('S3_CHAT_INVALID_'+label);
  return v;
}
function messagePath(threadId,id){
  return 'chats/'+ident(threadId,'THREAD')+'/messages/'+ident(id,'MESSAGE',MSG)+'.json';
}
function eventPath(threadId,id){
  return 'chats/'+ident(threadId,'THREAD')+'/events/'+ident(id,'EVENT',MSG)+'.json';
}
function role(v){
  if(!ROLES.has(v))throw new Error('S3_CHAT_INVALID_ROLE');
  return v;
}
function validateText(text){
  if(typeof text!=='string'||!text.trim()||text.length>MAX_TEXT)
    throw new Error('S3_CHAT_INVALID_TEXT');
  return text;
}
async function mapped(items,func,concurrency=12){
  let next=0;const out=Array(items.length);
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(next<items.length){
      const i=next++;
      out[i]=await func(items[i],i);
    }
  }));
  return out;
}
function sameData(a,b,fields){
  return !!a&&fields.every(field=>a[field]===b[field]);
}
function createS3ChatStore({objects,now=()=>Date.now(),maxScan=3000}={}){
  if(!objects?.putOnce||!objects?.getJson||!objects?.listJsonKeys||
     !Number.isInteger(maxScan)||maxScan<1)throw new Error('S3_CHAT_INVALID_STORE');
  const clock=()=>{
    const x=Number(now());
    if(!Number.isSafeInteger(x)||x<1)throw new Error('S3_CHAT_INVALID_TIME');
    return x;
  };
  async function existingOrWrite(key,record,fields){
    const old=await objects.getJson(key);
    if(old!==null){
      if(!sameData(old,record,fields))throw new Error('S3_CHAT_DUPLICATE_ID_CONFLICT');
      return {created:false,record:old};
    }
    try{
      const result=await objects.putOnce(key,record);
      return {created:result.created,record};
    }catch(error){
      // Concurrent idempotent retry can carry a different timestamp.
      if(error?.message!=='S3_HYBRID_IMMUTABLE_CONFLICT')throw error;
      const winner=await objects.getJson(key);
      if(!sameData(winner,record,fields))throw new Error('S3_CHAT_DUPLICATE_ID_CONFLICT');
      return {created:false,record:winner};
    }
  }
  async function send({threadId,messageId,actorId,actorRole,text,replyTo=''}){
    const key=messagePath(threadId,messageId);
    ident(actorId,'ACTOR');role(actorRole);validateText(text);
    if(replyTo)ident(replyTo,'REPLY',MSG);
    const record={v:1,kind:'message',id:messageId,threadId,actorId,
      actorRole,text,replyTo,createdAt:clock()};
    return existingOrWrite(key,record,
      ['v','kind','id','threadId','actorId','actorRole','text','replyTo']);
  }
  async function mutate({threadId,eventId,messageId,actorId,actorRole,
    action,text='',reaction='',enabled=true}){
    ident(threadId,'THREAD');ident(eventId,'EVENT',MSG);
    ident(actorId,'ACTOR');role(actorRole);ident(messageId,'MESSAGE',MSG);
    if(!['edit','delete','reaction'].includes(action))
      throw new Error('S3_CHAT_INVALID_ACTION');
    const original=await objects.getJson(messagePath(threadId,messageId));
    if(!original)throw new Error('S3_CHAT_MESSAGE_NOT_FOUND');
    if((action==='edit'||action==='delete')&&original.actorId!==actorId)
      throw new Error('S3_CHAT_FORBIDDEN');
    if(action==='edit')validateText(text);
    if(action==='reaction'&&(!/^.{1,12}$/u.test(reaction)||typeof enabled!=='boolean'))
      throw new Error('S3_CHAT_INVALID_REACTION');
    const record={v:1,kind:'event',threadId,id:eventId,
      action,targetMessageId:messageId,actorId,actorRole,
      text:action==='edit'?text:'',
      reaction:action==='reaction'?reaction:'',
      enabled:action==='reaction'?enabled:false,createdAt:clock()};
    return existingOrWrite(eventPath(threadId,eventId),record,
      ['v','kind','threadId','id','action','targetMessageId',
       'actorId','actorRole','text','reaction','enabled']);
  }
  async function markRead({threadId,eventId,upToMessageId,actorId,actorRole}){
    ident(threadId,'THREAD');ident(eventId,'EVENT',MSG);
    ident(actorId,'ACTOR');role(actorRole);
    const msg=await objects.getJson(messagePath(threadId,upToMessageId));
    if(!msg)throw new Error('S3_CHAT_MESSAGE_NOT_FOUND');
    const record={v:1,kind:'event',threadId,id:eventId,action:'read',
      targetMessageId:upToMessageId,actorId,actorRole,
      createdAt:clock()};
    return existingOrWrite(eventPath(threadId,eventId),record,
      ['v','kind','threadId','id','action','targetMessageId','actorId','actorRole']);
  }
  async function listThread({threadId,limit=100}){
    ident(threadId,'THREAD');
    if(!Number.isInteger(limit)||limit<1||limit>200)
      throw new Error('S3_CHAT_INVALID_LIMIT');
    const base='chats/'+threadId+'/';
    const [mkeys,ekeys]=await Promise.all([
      objects.listJsonKeys(base+'messages/',{limit:maxScan}),
      objects.listJsonKeys(base+'events/',{limit:maxScan})
    ]);
    const [msgs,events]=await Promise.all([
      mapped(mkeys,key=>objects.getJson(key)),
      mapped(ekeys,key=>objects.getJson(key))
    ]);
    const all=msgs.filter(x=>x?.kind==='message'&&x.threadId===threadId)
      .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
    const byId=new Map(all.map(x=>[x.id,{...x,editedAt:null,deleted:false,reactions:{}}]));
    const readCursors=new Map();
    const ordered=events.filter(x=>x?.kind==='event'&&x.threadId===threadId)
      .sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
    for(const event of ordered){
      const target=byId.get(event.targetMessageId);
      if(!target)continue;
      if(event.action==='edit'&&event.actorId===target.actorId&&!target.deleted){
        target.text=event.text;target.editedAt=event.createdAt;
      }else if(event.action==='delete'&&event.actorId===target.actorId){
        target.text='';target.deleted=true;
      }else if(event.action==='reaction'&&!target.deleted){
        const id=event.actorId;
        if(event.enabled)target.reactions[id]=event.reaction;
        else delete target.reactions[id];
      }else if(event.action==='read'){
        const reader=event.actorRole+':'+event.actorId;
        const prior=readCursors.get(reader);
        const candidate={createdAt:target.createdAt,id:target.id};
        if(!prior||candidate.createdAt>prior.createdAt||
           (candidate.createdAt===prior.createdAt&&candidate.id>prior.id))
          readCursors.set(reader,candidate);
      }
    }
    // Reading the latest page still scans the entire small prototype thread.
    // Fail closed at maxScan rather than silently skipping older events.
    return {messages:all.slice(-limit).map(x=>byId.get(x.id)),
      total:all.length,readCursors:Object.fromEntries(readCursors)};
  }
  return {send,mutate,markRead,listThread};
}
module.exports={createS3ChatStore};
