import { Uint64 } from '@ydbjs/value/primitive';

const PHONE = /^\d{10}$/;
const REACTIONS = new Set(['❤️','👍','👌','🙏','🥰','😁','🔥']);
function checkedPhone(v) {
  const phone = String(v || '').replace(/\D/g,'').slice(-10);
  if (!PHONE.test(phone)) throw new Error('Invalid parent phone.');
  return phone;
}
function messageFromRow(row) {
  const fileId=String(row.file_id || '');
  return {
    messageKey: String(row.message_key), phone:row.phone10, side:row.side,
    type:row.type || 'text', text:row.text || '', timestamp:Number(row.created_at || 0),
    readByParent:Boolean(row.read_by_parent), readByEducator:Boolean(row.read_by_educator),
    fileId, mediaUrl:fileId.startsWith('s3:')?'/media/s3/'+encodeURIComponent(fileId.slice(3)):
      fileId.startsWith('kv:')?'/media/'+encodeURIComponent(fileId.slice(3)):'',
    reaction:row.reaction || '', reply:row.reply_to_key?{messageKey:row.reply_to_key}:null,
    status:row.status || 'active'
  };
}
export { messageFromRow };

export function createChatOperations(sql) {
  if (!sql || typeof sql.begin !== 'function') throw new Error('YDB query client required.');
  const read = fn => sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write = fn => sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);

  async function listParents() {
    return read(async tx => {
      const [[profiles],[children]] = await Promise.all([
        tx`SELECT phone10, parent_name, child_id, child_name, relationship FROM parent_profiles`,
        tx`SELECT child_id, registered_first_name, surname FROM children`
      ]);
      const childrenMap=new Map(children.map(c=>[c.child_id,c]));
      return {ok:true,parents:profiles.map(p=>{
        const child=childrenMap.get(p.child_id)||{};
        return {
          phone:p.phone10,
          parentName:p.parent_name || '',
          childName:[child.registered_first_name || '',child.surname || ''].filter(Boolean).join(' ')||p.child_name||'',
          relationship:p.relationship || 'Родитель'
        };
      }).sort((a,b)=>a.childName.localeCompare(b.childName,'ru'))};
    });
  }
  async function listChats(bucket='all') {
    if (!['all','unread','read'].includes(bucket)) throw new Error('Unsupported chat filter.');
    return read(async tx => {
      const [states,pins,profiles,children] = (await Promise.all([
        tx`SELECT phone10, last_side, last_type, last_text, last_at, educator_has_unread FROM chat_thread_state`,
        tx`SELECT phone10, bucket FROM chat_pins`,
        tx`SELECT phone10, parent_name, child_id, child_name, relationship FROM parent_profiles`,
        tx`SELECT child_id, registered_first_name, surname FROM children`
      ])).map(set=>set[0]||[]);
      const pinMap=new Map(pins.map(row=>[row.phone10,row.bucket]));
      const profileMap=new Map(profiles.map(row=>[row.phone10,row]));
      const childMap=new Map(children.map(row=>[row.child_id,row]));
      const chats=states.map(state=>{
        const profile=profileMap.get(state.phone10);
        if(!profile)return null;
        const child=childMap.get(profile.child_id)||{};
        const pinnedBucket=pinMap.get(state.phone10)||'';
        const hasUnread=Boolean(state.educator_has_unread);
        return {
          phone:state.phone10,parentName:profile.parent_name || '',
          childName:[child.registered_first_name,child.surname].filter(Boolean).join(' ')||profile.child_name||'',
          relationship:profile.relationship||'Родитель',lastSide:state.last_side,
          lastType:state.last_type || 'text', lastText:state.last_text || '',
          hasUnread,pinnedBucket,_lastAt:Number(state.last_at || 0)
        };
      }).filter(Boolean).filter(row=>bucket==='all'||
          (bucket==='unread'?(row.hasUnread||row.pinnedBucket==='unread'):
            (!row.hasUnread||row.pinnedBucket==='read')));
      chats.sort((a,b)=>Number(b.pinnedBucket===(bucket==='read'?'read':'unread'))-
        Number(a.pinnedBucket===(bucket==='read'?'read':'unread')) || b._lastAt-a._lastAt);
      return {ok:true,chats:chats.map(({_lastAt,...row})=>row)};
    });
  }
  async function thread(phoneRaw,beforeRaw='',limitRaw=50) {
    const phone10=checkedPhone(phoneRaw);
    const beforeKey=String(beforeRaw||'');
    const limit=Math.max(1,Math.min(150,Number(limitRaw)||50));
    return read(async tx => {
      const [[profile]] = await tx`SELECT phone10,parent_name,child_id,child_name,relationship
        FROM parent_profiles WHERE phone10=${phone10}`;
      if (!profile) throw new Error('Контакт уже удалён.');
      const [[child]] = await tx`SELECT registered_first_name,surname FROM children WHERE child_id=${profile.child_id}`;
      let boundary=null;
      if (beforeKey) {
        const [[marker]]=await tx`SELECT message_key,created_at FROM chat_messages
          WHERE phone10=${phone10} AND message_key=${beforeKey}`;
        boundary=marker||null;
      }
      let rows;
      if (boundary) {
        const [result]=await tx`SELECT phone10,message_key,side,type,text,file_id,reply_to_key,
            reaction,status,created_at,read_by_parent,read_by_educator
          FROM chat_messages
          WHERE phone10=${phone10} AND status=${'active'} AND
          (created_at < ${new Uint64(BigInt(boundary.created_at))} OR
           (created_at = ${new Uint64(BigInt(boundary.created_at))} AND message_key < ${boundary.message_key}))
          ORDER BY created_at DESC,message_key DESC LIMIT ${limit+1}`;
        rows=result;
      } else {
        const [result]=await tx`SELECT phone10,message_key,side,type,text,file_id,reply_to_key,
            reaction,status,created_at,read_by_parent,read_by_educator
          FROM chat_messages WHERE phone10=${phone10} AND status=${'active'}
          ORDER BY created_at DESC,message_key DESC LIMIT ${limit+1}`;
        rows=result;
      }
      const hasMore=rows.length>limit;
      const messages=rows.slice(0,limit).reverse().map(messageFromRow);
      const byKey=new Map(messages.map(m=>[m.messageKey,m]));
      const missing=[...new Set(messages.map(m=>m.reply?.messageKey).filter(k=>k&&!byKey.has(k)))];
      for (const key of missing) {
        const [[referenced]]=await tx`SELECT phone10,message_key,side,type,text,file_id,reply_to_key,reaction,
          status,created_at,read_by_parent,read_by_educator FROM chat_messages
          WHERE phone10=${phone10} AND message_key=${key} AND status=${'active'}`;
        if (referenced) {
          const m=messageFromRow(referenced);
          byKey.set(m.messageKey,m);
        }
      }
      messages.forEach(m=>{
        if(!m.reply?.messageKey)return;
        const target=byKey.get(m.reply.messageKey);
        if (target)m.reply={messageKey:target.messageKey,side:target.side,type:target.type,text:target.text,fileId:target.fileId};
      });
      return {ok:true,phone:phone10,parentName:profile.parent_name||'',
        childName:[child?.registered_first_name,child?.surname].filter(Boolean).join(' '),
        relationship:profile.relationship||'Родитель',messages,hasMore};
    });
  }
  async function markRead(role,phoneRaw,markAsUnread=false) {
    const phone10=checkedPhone(phoneRaw);
    if(!['parent','educator'].includes(role))throw new Error('Unknown role.');
    if(role==='parent'&&markAsUnread)throw new Error('Parent cannot mark educator unread.');
    return write(async tx=>{
      if(role==='educator') {
        const value=!markAsUnread;
        await tx`UPDATE chat_messages SET read_by_educator=${value}
          WHERE phone10=${phone10} AND side=${'parent'} AND status=${'active'}`;
        await tx`UPDATE chat_thread_state SET educator_has_unread=${!value} WHERE phone10=${phone10}`;
      } else {
        await tx`UPDATE chat_messages SET read_by_parent=${true}
          WHERE phone10=${phone10} AND side=${'educator'} AND status=${'active'}`;
        await tx`UPDATE chat_thread_state SET parent_has_unread=${false} WHERE phone10=${phone10}`;
      }
      return {ok:true};
    });
  }
  async function parentUnread(phoneRaw) {
    const phone10=checkedPhone(phoneRaw);
    return read(async tx=>{
      const [[row]]=await tx`SELECT parent_has_unread FROM chat_thread_state WHERE phone10=${phone10}`;
      return {ok:true,hasUnread:Boolean(row?.parent_has_unread)};
    });
  }
  async function pin(phoneRaw,bucket) {
    const phone10=checkedPhone(phoneRaw);
    if(!['','read','unread'].includes(bucket))throw new Error('Invalid pin bucket.');
    return write(async tx=>{
      await tx`UPSERT INTO chat_pins (phone10,bucket,updated_at)
        VALUES (${phone10},${bucket},${new Uint64(BigInt(Date.now()))})`;
      return {ok:true,pinned:!!bucket,bucket};
    });
  }
  async function mutate(kind,messageKey,auth,payload={}) {
    if(!['reaction','edit','delete'].includes(kind))throw new Error('Invalid message action.');
    if(!auth||!['parent','educator'].includes(auth.role))throw new Error('Unauthorized.');
    const key=String(messageKey||'');
    if(!key||key.length>200)throw new Error('Invalid message key.');
    return write(async tx=>{
      const [[row]]=await tx`SELECT phone10,message_key,side,type,text,reaction,status
        FROM chat_messages VIEW chat_messages_by_key WHERE message_key=${key}`;
      if(!row||row.status!=='active')throw new Error('Message not found.');
      if(auth.role==='parent'&&auth.phone10!==row.phone10)throw new Error('Forbidden.');
      if(kind==='reaction') {
        const reaction=String(payload.reaction||'');
        if(reaction&&!REACTIONS.has(reaction))throw new Error('Bad reaction.');
        const next=row.reaction===reaction?'':reaction;
        await tx`UPDATE chat_messages SET reaction=${next}
          WHERE phone10=${row.phone10} AND message_key=${key}`;
        return {ok:true,reaction:next};
      }
      if(auth.role!==row.side && !(auth.role==='educator'&&kind==='delete'&&row.side==='parent')) {
        throw new Error('Only own messages can be changed.');
      }
      if(kind==='edit') {
        const text=String(payload.text||'').trim().slice(0,4000);
        if(!text)throw new Error('Text is required.');
        await tx`UPDATE chat_messages SET text=${text},edited_at=${new Uint64(BigInt(Date.now()))}
          WHERE phone10=${row.phone10} AND message_key=${key}`;
        return {ok:true,text};
      }
      await tx`UPDATE chat_messages SET status=${'deleted'}
        WHERE phone10=${row.phone10} AND message_key=${key}`;
      return {ok:true};
    });
  }
  return {listParents,listChats,thread,markRead,parentUnread,pin,mutate};
}
