import { createHash, randomUUID } from 'node:crypto';
import {parseChatGallery} from './chat-gallery.mjs';

const PHONE_RE = /^\d{10}$/;
const TYPES = new Set(['text', 'image', 'video', 'gallery']);
const SIDES = new Set(['parent', 'educator']);

const digest = str => createHash('sha256').update(str, 'utf8').digest('hex');

// Service-only operation: HTTP session verification and role checks belong in API routes.
// No patient text is ever included in notification payloads or diagnostic logs.
export function prepareChatMessage(input, timestamp = Date.now()) {
  const phone10 = String(input?.phone10 || '');
  const side = String(input?.side || '');
  const type = String(input?.type || 'text');
  const text = String(input?.text || '').trim();
  const fileId = String(input?.fileId || '').trim();
  const clientMessageId = String(input?.clientMessageId || '');
  const replyToKey = String(input?.replyToKey || '');
  if (!PHONE_RE.test(phone10)) throw new Error('Invalid chat recipient.');
  if (!SIDES.has(side) || !TYPES.has(type)) throw new Error('Invalid sender or message type.');
  if (clientMessageId.length < 8 || clientMessageId.length > 200 ||
      !/^[A-Za-z0-9_-]+$/.test(clientMessageId)) throw new Error('Invalid client message identifier.');
  if (!text && !fileId) throw new Error('Empty chat message.');
  if (text.length > 4000 || fileId.length > (type==='gallery'?1200:200) || replyToKey.length > 200) {
    throw new Error('Message exceeds allowed length.');
  }
  if (type === 'text' && !text) throw new Error('Text message has no text.');
  if (type === 'gallery' && !parseChatGallery(fileId)) {
    throw new Error('Gallery must contain 2 to 5 owned photos or videos.');
  }
  if (type !== 'text' && type !== 'gallery' && !fileId.startsWith('s3:')) {
    throw new Error('New media messages must refer to private Timeweb S3 objects.');
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error('Invalid timestamp.');
  return {
    phone10, side, type, text, fileId, clientMessageId, replyToKey, timestamp,
    payloadHash: digest([phone10, side, type, text, fileId, replyToKey].join('\u0000'))
  };
}

export function createChatStore(sql,{queuePush=true}={}) {
  if (!sql || typeof sql.begin !== 'function') throw new Error('PostgreSQL query client required.');
  return {
    async send(input) {
      const msg = prepareChatMessage(input);
      const { phone10, side, type, text, fileId, clientMessageId, replyToKey, payloadHash, timestamp } = msg;
      const now = BigInt(timestamp);
      const zero = 0n;
      const isParent = side === 'parent';
      return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async tx => {
        const [[seen]] = await tx`SELECT message_key, payload_hash
          FROM chat_message_dedup WHERE phone10 = ${phone10} AND client_message_id = ${clientMessageId}`;
        if (seen) {
          if (seen.payload_hash !== payloadHash) throw new Error('Message identifier reused for different content.');
          return { status: 'duplicate', messageKey: seen.message_key, phone10 };
        }
        const [[profile]] = await tx`SELECT phone10,child_name,child_id FROM parent_profiles WHERE phone10 = ${phone10}`;
        if (!profile) throw new Error('Chat is closed: parent profile is inactive.');
        if (type !== 'text') {
          const files=type==='gallery'?parseChatGallery(fileId).map(item=>item.fileId):[fileId];
          for(const mediaId of files){
            const [[registered]]=await tx`SELECT phone10 FROM chat_media WHERE file_id=${mediaId}`;
            if(!registered||registered.phone10!==phone10)
              throw new Error('Media upload does not belong to this chat.');
          }
        }
        if (replyToKey) {
          const [[target]] = await tx`SELECT message_key FROM chat_messages
            WHERE phone10 = ${phone10} AND message_key = ${replyToKey} AND status = ${'active'}`;
          if (!target) throw new Error('Reply target is absent or belongs to another chat.');
        }
        const [[thread]] = await tx`SELECT last_at, educator_has_unread, parent_has_unread
          FROM chat_thread_state WHERE phone10 = ${phone10}`;
        const lastAt = Number(thread?.last_at || 0);
        if (timestamp < lastAt) throw new Error('Chat clock moved backwards; retry with current time.');
        const messageKey = `${timestamp}-${side}-${randomUUID()}`;
        const readParent = isParent;
        const readEducator = !isParent;
        await tx.upsert`INSERT INTO chat_messages
          (phone10, message_key, client_message_id, side, type, text, file_id,
           reply_to_key, reaction, status, created_at, edited_at, delete_after,
           read_by_parent, read_by_educator)
          VALUES (${phone10}, ${messageKey}, ${clientMessageId}, ${side}, ${type},
                  ${text}, ${fileId}, ${replyToKey}, ${''}, ${'active'}, ${now},
                  ${zero}, ${zero}, ${readParent}, ${readEducator})`;
        await tx.upsert`INSERT INTO chat_message_dedup
          (phone10, client_message_id, message_key, payload_hash, created_at)
          VALUES (${phone10}, ${clientMessageId}, ${messageKey}, ${payloadHash}, ${now})`;

        const educatorUnread = Boolean(thread?.educator_has_unread) || isParent;
        const parentUnread = Boolean(thread?.parent_has_unread) || !isParent;
        await tx.upsert`INSERT INTO chat_thread_state
          (phone10, last_message_key, last_side, last_type, last_text, last_at,
           educator_has_unread, parent_has_unread)
          VALUES (${phone10}, ${messageKey}, ${side}, ${type}, ${text}, ${now},
                  ${educatorUnread}, ${parentUnread})`;

        // Disabled push must not accumulate deferred notifications in PostgreSQL.
        // The chat message itself is committed normally regardless of this switch.
        if(!queuePush)return {status:'created',messageKey,phone10,timestamp};

        // The recipient sees the actual sender and a short message preview.
        // Push content may be shown on the device lock screen by the browser.
        let childName=String(profile.child_name||'').trim();
        if(isParent && profile.child_id){
          const [[child]]=await tx`SELECT registered_first_name,surname FROM children
            WHERE child_id=${profile.child_id}`;
          const currentName=[child?.registered_first_name,child?.surname]
            .map(value=>String(value||'').trim()).filter(Boolean).join(' ');
          if(currentName)childName=currentName;
        }
        const previewText=text.replace(/\s+/g,' ').slice(0,180);
        const galleryItems=type==='gallery'?parseChatGallery(fileId):null;
        const mediaLabel=type==='video'?'🎬 Видео':type==='gallery'?
          '📎 '+galleryItems.length+' вложений':'📷 Фото';
        const body=type==='text'?previewText:
          [mediaLabel,previewText].filter(Boolean).join(' · ');
        const eventId = 'chat_' + digest(phone10 + '\u0000' + clientMessageId);
        const role = isParent ? 'educator' : 'parent';
        const notification = JSON.stringify({
          title: isParent?(childName||'Сообщение от родителя'):'Детское Отделение Медси',
          body, type: 'chat', url: isParent ? '/tutors' : '/'
        });
        await tx.upsert`INSERT INTO push_outbox
          (event_id, role, phone10, notification_json, status, attempts, next_attempt_at, created_at)
          VALUES (${eventId}, ${role}, ${phone10}, ${notification},
                  ${'pending'}, ${zero}, ${now}, ${now})`;
        return { status: 'created', messageKey, phone10, timestamp };
      });
    }
  };
}
