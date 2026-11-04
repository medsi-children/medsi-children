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
