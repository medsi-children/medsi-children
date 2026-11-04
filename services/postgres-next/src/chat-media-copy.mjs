import {createHash,createHmac} from 'node:crypto';
import storageDefinitions from '../../../lib/s3-storage.js';
import {captureD1ChatMessageManifest,inventoryD1ChatMedia} from './d1-chat-capture.mjs';
import {isChatMediaKey} from '../app/media-service.mjs';
import {generateManifest} from '../app/migration-audit.mjs';

const MAX_BYTES=100*1024*1024;

// Offline only. Source adapters must enforce the same maximum while reading.
export async function copyD1ChatMedia(messages,{readSource,destination,hmacKey,explicitCopy}={}){
  if(explicitCopy!==true || typeof hmacKey!=='string' || Buffer.byteLength(hmacKey)<32 ||
     typeof readSource!=='function' || !destination?.configured){
    throw new Error('Explicit media copy approval and storage configuration required.');
  }
  const {objects,summary}=inventoryD1ChatMedia(messages);
  const active=objects.filter(object=>object.activeReferences>0);
  if(summary.missingReferences || active.some(object=>!object.phone10 || object.source==='unresolved')){
    throw new Error('Active chat attachments have unresolved references or owners.');
  }
  const mapping=[];
  for(const object of active){
    try{
      const {body,contentType}=await readSource(object.source,object.fileId,MAX_BYTES);
      if(!Buffer.isBuffer(body) || body.length<1 || body.length>MAX_BYTES ||
         typeof contentType!=='string')throw new Error();
      const mime=contentType.toLowerCase().split(';')[0].trim();
      const media=storageDefinitions.mediaDefinition(mime);
      if(!media)throw new Error();
      const digest=createHash('sha256').update(body).digest('hex');
      const id=createHmac('sha256',hmacKey).update(JSON.stringify([object.phone10,object.fileId])).digest('hex');
      const alreadyInS3=object.source==='s3';
      const key=alreadyInS3 ? object.fileId.slice(3) : 'chat/'+id+media.extension;
      if(!isChatMediaKey(key))throw new Error();
      if(!await destination.hasObject(key)){
        if(alreadyInS3)throw new Error();
        try{
          await destination.putBuffer(key,body,mime,{ifAbsent:true});
        }catch(error){
          if(error?.$metadata?.httpStatusCode!==412)throw error;
        }
      }
      if(await destination.sha256Object(key)!==digest)throw new Error();
      mapping.push({sourceFileId:object.fileId,fileId:'s3:'+key,phone10:object.phone10,
        bytes:body.length,sha256:digest});
    }catch(_){
      // Provider errors may contain private object keys or URLs.
      throw new Error('Chat attachment copy or verification failed.');
    }
  }
  return mapping;
}

// Rewriting is an in-memory transformation of the frozen capture. The caller
// signs the rewritten streams before the separate PostgreSQL import.
export function prepareChatMediaImport(messages,mapping){
  const {objects,summary}=inventoryD1ChatMedia(messages);
  const required=objects.filter(object=>object.activeReferences>0);
  if(summary.missingReferences || !Array.isArray(mapping) || mapping.length!==required.length){
    throw new Error('Incomplete chat attachment mapping.');
  }
  const bySource=new Map(),byTarget=new Set();
  for(const entry of mapping){
    if(!entry || typeof entry.sourceFileId!=='string' || bySource.has(entry.sourceFileId) ||
       typeof entry.fileId!=='string' || !entry.fileId.startsWith('s3:') ||
       !isChatMediaKey(entry.fileId.slice(3)) || byTarget.has(entry.fileId) ||
       (entry.sourceFileId.startsWith('s3:') && entry.sourceFileId!==entry.fileId) ||
       !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) ||
       entry.bytes<1 || entry.bytes>MAX_BYTES){
      throw new Error('Invalid chat attachment mapping.');
    }
    bySource.set(entry.sourceFileId,entry);
    byTarget.add(entry.fileId);
  }
  for(const object of required){
    const entry=bySource.get(object.fileId);
    if(!object.phone10 || object.source==='unresolved' || entry?.phone10!==object.phone10){
      throw new Error('Chat attachment mapping has an unresolved owner or source.');
    }
  }
  const firstReference=new Map();
  const rewritten=messages.map(row=>{
    const entry=bySource.get(row.file_id);
    if(!entry || row.status!=='active')return {...row};
    const previous=firstReference.get(entry.fileId);
    if(previous===undefined || BigInt(row.created_at)<BigInt(previous)){
      firstReference.set(entry.fileId,String(row.created_at));
    }
    return {...row,file_id:entry.fileId};
  });
  return {
    messages:rewritten,
    chatMedia:mapping.map(entry=>({
      file_id:entry.fileId,phone10:entry.phone10,uploaded_at:firstReference.get(entry.fileId)
    })),
    s3Objects:mapping.map(entry=>({file_id:entry.fileId,bytes:entry.bytes,sha256:entry.sha256}))
  };
}

export async function importChatMediaOwnership(sql,messages,mapping,
  {hmacKey,expectedManifest,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true || freezeConfirmed!==true){
    throw new Error('Explicit frozen chat media import approval required.');
  }
  const plan=prepareChatMediaImport(messages,mapping);
  const wanted=generateManifest('chat_media',plan.chatMedia,hmacKey);
  if(expectedManifest?.stream!==wanted.stream || expectedManifest.digest!==wanted.digest ||
     expectedManifest.count!==wanted.count || expectedManifest.duplicateRows!==wanted.duplicateRows){
    throw new Error('Chat media ownership manifest mismatch.');
  }
  const chat=captureD1ChatMessageManifest(plan.messages,hmacKey);
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.chat_messages, public.chat_media IN SHARE ROW EXCLUSIVE MODE`;
    const [storedMessages]=await tx`SELECT * FROM public.chat_messages`;
    if(generateManifest('chat_messages',storedMessages,hmacKey).digest!==chat.digest){
      throw new Error('Import the matching rewritten chat messages before media ownership.');
    }
    const [existing]=await tx`SELECT * FROM public.chat_media`;
    if(!existing.length){
      for(const row of plan.chatMedia){
        await tx`INSERT INTO public.chat_media (file_id,phone10,uploaded_at)
          VALUES (${row.file_id},${row.phone10},${row.uploaded_at})`;
      }
    }
    const [stored]=await tx`SELECT * FROM public.chat_media`;
    if(generateManifest('chat_media',stored,hmacKey).digest!==wanted.digest){
      throw new Error('PostgreSQL chat media ownership differs from the baseline.');
    }
    return {count:stored.length,alreadyImported:existing.length>0};
  });
}
