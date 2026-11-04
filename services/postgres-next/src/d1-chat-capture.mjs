import {prepareChatMessage} from '../app/chat-store.mjs';
import {generateManifest} from '../app/migration-audit.mjs';

// Run the fixed projection in the approved D1 export environment. The local
// normalizer accepts exported rows and never connects to Cloudflare.
export const D1_CHAT_MESSAGES_QUERY=`SELECT phone10, message_key, client_message_id,
  side, type, text, file_id, reply_to_key, reaction, status, created_at,
  edited_at, delete_after, read_by_parent, read_by_educator
  FROM chat_messages ORDER BY id`;

function invalid(){
  throw new Error('Invalid or ambiguous D1 chat message capture.');
}

function timestamp(value, nullable=false){
  if(value===null && nullable)return null;
  if(typeof value==='number' && !Number.isSafeInteger(value))invalid();
  if(typeof value!=='number' && typeof value!=='string')invalid();
  const text=String(value);
  if(!/^(0|[1-9][0-9]{0,18})$/.test(text) || BigInt(text)>9223372036854775807n)invalid();
  return text;
}

function flag(value){
  if(value!==0 && value!==1)invalid();
  return value===1;
}

export function normalizeD1ChatMessages(input){
  if(!Array.isArray(input))invalid();
  const keys=new Set(), clientKeys=new Set();
  return input.map(row=>{
    if(!row || typeof row.phone10!=='string' || !/^\d{10}$/.test(row.phone10))invalid();
    for(const field of ['message_key','client_message_id','side','type','text',
      'file_id','reply_to_key','reaction','status']){
      if(typeof row[field]!=='string' || row[field].includes('\0'))invalid();
    }
    if(!row.message_key || keys.has(row.message_key) ||
       !['parent','educator'].includes(row.side) ||
       !['text','image','video'].includes(row.type) ||
       !['active','deleted'].includes(row.status))invalid();
    keys.add(row.message_key);
    if(row.client_message_id){
      const key=row.phone10+'\0'+row.client_message_id;
      if(clientKeys.has(key))invalid();
      clientKeys.add(key);
    }
    return {
      phone10:row.phone10,message_key:row.message_key,client_message_id:row.client_message_id,
      side:row.side,type:row.type,text:row.text,file_id:row.file_id,reply_to_key:row.reply_to_key,
      reaction:row.reaction,status:row.status,created_at:timestamp(row.created_at),
      edited_at:timestamp(row.edited_at,true),delete_after:timestamp(row.delete_after,true),
      read_by_parent:flag(row.read_by_parent),read_by_educator:flag(row.read_by_educator)
    };
  });
}

export function captureD1ChatMessageManifest(input,hmacKey){
  return generateManifest('chat_messages',normalizeD1ChatMessages(input),hmacKey);
}

// First baseline stream only. The cutover coordinator must freeze writers and
// handle media and other chat streams before enabling any new writes.
export async function importD1ChatMessages(sql,input,{hmacKey,expectedManifest,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true || freezeConfirmed!==true){
    throw new Error('Explicit frozen chat baseline import approval required.');
  }
  const rows=normalizeD1ChatMessages(input);
  const manifest=generateManifest('chat_messages',rows,hmacKey);
  const matches=other=>other?.stream===manifest.stream && other.count===manifest.count &&
    other.duplicateRows===manifest.duplicateRows && other.digest===manifest.digest;
  if(!matches(expectedManifest))throw new Error('D1 chat baseline manifest mismatch.');
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.chat_messages IN SHARE ROW EXCLUSIVE MODE`;
    const [existing]=await tx`SELECT * FROM public.chat_messages`;
    if(existing.length){
      if(!matches(generateManifest('chat_messages',existing,hmacKey))){
        throw new Error('PostgreSQL chat messages differ from the baseline.');
      }
      return {count:rows.length,alreadyImported:true};
    }
    for(const row of rows){
      await tx`INSERT INTO public.chat_messages
        (phone10,message_key,client_message_id,side,type,text,file_id,reply_to_key,
         reaction,status,created_at,edited_at,delete_after,read_by_parent,read_by_educator)
        VALUES (${row.phone10},${row.message_key},${row.client_message_id},${row.side},${row.type},
          ${row.text},${row.file_id},${row.reply_to_key},${row.reaction},${row.status},${row.created_at},
          ${row.edited_at},${row.delete_after},${row.read_by_parent},${row.read_by_educator})`;
    }
    const [imported]=await tx`SELECT * FROM public.chat_messages`;
    if(!matches(generateManifest('chat_messages',imported,hmacKey))){
      throw new Error('PostgreSQL chat verification failed; rolling back.');
    }
    return {count:rows.length,alreadyImported:false};
  });
}

export const D1_CHAT_PINS_QUERY='SELECT phone10, bucket, updated_at FROM chat_pins ORDER BY phone10';

// The message projection is ordered by ascending D1 id. On equal timestamps
// D1 uses the larger id as the latest message, so retain capture order.
export function deriveD1ChatRelatedStreams(messageInput,pinInput){
  if(!Array.isArray(pinInput))invalid();
  const threads=new Map(),dedup=[],pins=new Map();
  for(const row of normalizeD1ChatMessages(messageInput)){
    if(row.client_message_id){
      let payloadHash=null;
      if(row.status==='active' && !Number(row.edited_at)){
        try{
          payloadHash=prepareChatMessage({
            phone10:row.phone10,side:row.side,type:row.type,text:row.text,fileId:row.file_id,
            clientMessageId:row.client_message_id,replyToKey:row.reply_to_key
          },Number(row.created_at)).payloadHash;
        }catch(_){
          // Historic payload cannot be reconstructed; keep the ID reserved.
        }
      }
      dedup.push({phone10:row.phone10,client_message_id:row.client_message_id,
        message_key:row.message_key,payload_hash:payloadHash,created_at:row.created_at});
    }
    if(row.status!=='active')continue;
    const previous=threads.get(row.phone10);
    const latest=!previous || BigInt(row.created_at)>=BigInt(previous.last_at)
      ? {phone10:row.phone10,last_message_key:row.message_key,last_side:row.side,
        last_type:row.type,last_text:row.text,last_at:row.created_at}
      : previous;
    threads.set(row.phone10,{...latest,
      educator_has_unread:Boolean(previous?.educator_has_unread) || (row.side==='parent'&&!row.read_by_educator),
      parent_has_unread:Boolean(previous?.parent_has_unread) || (row.side==='educator'&&!row.read_by_parent)});
  }
  for(const row of pinInput){
    if(!row || typeof row.phone10!=='string' || !/^\d{10}$/.test(row.phone10) ||
       !['read','unread'].includes(row.bucket) || pins.has(row.phone10))invalid();
    pins.set(row.phone10,{phone10:row.phone10,bucket:row.bucket,updated_at:timestamp(row.updated_at)});
  }
  return {chat_thread_state:[...threads.values()],chat_message_dedup:dedup,chat_pins:[...pins.values()]};
}

export function captureD1ChatRelatedManifests(messages,pins,hmacKey){
  return Object.entries(deriveD1ChatRelatedStreams(messages,pins))
    .map(([stream,rows])=>generateManifest(stream,rows,hmacKey));
}

export async function importD1ChatRelatedStreams(sql,messages,pins,
  {hmacKey,expectedManifests,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true || freezeConfirmed!==true){
    throw new Error('Explicit frozen chat baseline import approval required.');
  }
  const streams=Object.entries(deriveD1ChatRelatedStreams(messages,pins));
  const matches=(expected,actual)=>expected?.stream===actual.stream &&
    expected.count===actual.count && expected.duplicateRows===actual.duplicateRows &&
    expected.digest===actual.digest;
  if(!Array.isArray(expectedManifests)||expectedManifests.length!==streams.length||
     streams.some(([name,rows])=>!matches(expectedManifests.find(item=>item?.stream===name),
       generateManifest(name,rows,hmacKey)))){
    throw new Error('D1 related chat manifests mismatch.');
  }
  const messageManifest=captureD1ChatMessageManifest(messages,hmacKey);
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.chat_messages, public.chat_thread_state,
      public.chat_message_dedup, public.chat_pins IN SHARE ROW EXCLUSIVE MODE`;
    const [imported]=await tx`SELECT * FROM public.chat_messages`;
    if(!matches(messageManifest,generateManifest('chat_messages',imported,hmacKey))){
      throw new Error('Import the matching chat messages before their related streams.');
    }
    const counts={};
    for(const [name,rows] of streams){
      const table=tx.identifier(name);
      const expected=generateManifest(name,rows,hmacKey);
      const [existing]=await tx`SELECT * FROM public.${table}`;
      if(!existing.length){
        for(const row of rows){
          const columns=Object.keys(row);
          const parts=['INSERT INTO public.',' (',...columns.slice(1).map(()=>', '),') VALUES (',
            ...columns.slice(1).map(()=>', '),')'];
          await tx(parts,table,...columns.map(column=>tx.identifier(column)),...Object.values(row));
        }
      }
      const [stored]=await tx`SELECT * FROM public.${table}`;
      if(!matches(expected,generateManifest(name,stored,hmacKey))){
        throw new Error('Related PostgreSQL chat stream does not match the baseline.');
      }
      counts[name]=rows.length;
    }
    return counts;
  });
}
