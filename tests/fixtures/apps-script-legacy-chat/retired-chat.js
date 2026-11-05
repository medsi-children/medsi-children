/* Historical implementations from 991b30e. Not deployed.
 * These fragments depend on the original project globals; not a standalone application.
 * Restoring any fragment requires a reviewed source change, never pasting it into production. */

function getEducatorChatPins_() {
  const sh = ensureChatPinsSheet_();
  const lastRow = sh.getLastRow();
  const pins = {};
  if (lastRow < 2) return pins;

  sh.getRange(2, 1, lastRow - 1, 2).getValues().forEach(row => {
    const phone10 = last10_(row[0]);
    const bucket = String(row[1] || '').trim().toLowerCase();
    if (phone10 && (bucket === 'unread' || bucket === 'read')) pins[phone10] = bucket;
  });
  return pins;
}

function setEducatorChatPin(phoneRaw, bucketRaw, tutorTokenRaw) {
  requireTutorSession_(tutorTokenRaw);
  const phone10 = last10_(phoneRaw);
  const bucket = String(bucketRaw || '').trim().toLowerCase();
  if (!phone10 || (bucket !== 'unread' && bucket !== 'read')) {
    return { ok:false, message:'Не удалось определить список для закрепления.' };
  }

  try {
    return withChatWriteLock_(function() {
      const sh = ensureChatPinsSheet_();
      const lastRow = sh.getLastRow();
      const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 2).getValues() : [];
      const matches = [];
      rows.forEach((row, index) => {
        if (last10_(row[0]) === phone10) matches.push({ row: index + 2, bucket: String(row[1] || '').trim().toLowerCase() });
      });

      const isAlreadyPinnedHere = matches.some(match => match.bucket === bucket);
      for (let i = matches.length - 1; i >= 0; i--) sh.deleteRow(matches[i].row);

      if (!isAlreadyPinnedHere) {
        sh.appendRow([phone10, bucket, new Date()]);
      }
      clearGetChatMessagesCache(phone10);
      return { ok:true, pinned:!isAlreadyPinnedHere, bucket:!isAlreadyPinnedHere ? bucket : '' };
    });
  } catch (e) {
    return { ok:false, message:'Ошибка закрепления чата: ' + (e.message || e) };
  }
}

function notifyNewChatMessage_(profile, side, type, text) {
  try {
    const preview = buildChatPreviewText_(type, text) || 'Новое сообщение';
    const messageTag = String(new Date().getTime());

    if (side === 'parent') {
      const phone10 = last10_(profile.phone || '');
      const notification = {
        title: profile.childName || 'Медси Бот',
        body: preview,
        url: '/tutors',
        tag: 'medsi-educator-chat-' + messageTag
      };

      const serverResult = sendPushNotification_('educator', '', notification);

      return {
        server: serverResult,
        fallback: buildPushClientPayload_('educator', '', notification)
      };
    }

    if (side === 'educator') {
      const notification = {
        title: 'Детское Отделение Медси',
        body: preview,
        url: '/',
        tag: 'medsi-parent-chat-' + last10_(profile.phone || '') + '-' + messageTag
      };

      const serverResult = sendPushNotification_('parent', profile.phone || '', notification);

      return {
        server: serverResult,
        fallback: buildPushClientPayload_('parent', profile.phone || '', notification)
      };
    }
  } catch (e) {
    Logger.log('Push notification error: ' + (e.message || e));
    return { ok: false, message: String(e && e.message || e) };
  }

  return { ok: false, message: 'No push side matched' };
}

function getAllChatMessages(tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const sh = ensureChatSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, chats: {} };

    // Performance: load only recent rows
    const startRow = 2;
    const rows = sh.getRange(startRow, 1, lastRow - startRow + 1, 14).getValues();

    const byPhone = {};

    rows.forEach(r => {
      const phone = normalizePhone_(r[1]);
      const phone10 = last10_(phone);
      if (!phone10) return;

      const parentName = String(r[2] || '').trim();
      const childName = String(r[3] || '').trim();
      const side = String(r[4] || '').trim();
      const type = String(r[5] || '').trim() || 'text';
      const textCell = String(r[6] || '').trim();
      const fileId = String(r[7] || '').trim();
      const ts = r[0];
      const readByParent = r[10] === true || String(r[10]).toLowerCase() === 'true';
      const readByEducator = r[11] === true || String(r[11]).toLowerCase() === 'true';
      const reaction = normalizeReaction_(r[12] || '');
      const reply = parseReplyContext_(r[13]);

      let mediaUrl = '';
      let videoUrl = '';
      let videoTitle = '';
      let text = textCell;

      if (fileId) {
        if (type === 'image') {
          mediaUrl = buildDriveImageUrl_(fileId);
        } else if (type === 'video') {
            mediaUrl = buildDriveImageUrl_(fileId);
        }
      }

      if (type === 'video') {
        const parsedVideo = parseVideoPayload_(textCell);
        videoUrl = parsedVideo.videoUrl;
        videoTitle = parsedVideo.videoTitle;
        text = parsedVideo.caption;
      }

      if (!byPhone[phone10]) {
        byPhone[phone10] = {
          phone: phone,
          parentName: parentName,
          childName: childName,
          messages: []
        };
      }

      // Update names from latest message
      if (parentName) byPhone[phone10].parentName = parentName;
      if (childName) byPhone[phone10].childName = childName;

      byPhone[phone10].messages.push({
        messageKey: buildMessageKey_(ts, side),
        side: side,
        type: type,
        text: text,
        mediaUrl: mediaUrl,
        videoUrl: videoUrl,
        videoTitle: videoTitle,
        parentName: parentName,
        childName: childName,
        timestamp: humanTime_(ts),
        readByParent: readByParent,
        readByEducator: readByEducator,
        reaction: reaction,
        reply: reply
      });
    });

    return { ok: true, chats: byPhone };
  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки всех сообщений: ' + (e.message || e) };
  }
}

function appendChatMessage_(profile, side, type, text, fileId, deleteAfter, status, replyToKey) {
  return withChatWriteLock_(function() {
    const sh = ensureChatSheet_();

    const readByParent = side === 'educator' ? false : true;
    const readByEducator = side === 'parent' ? false : true;
    const ts = new Date();
    const replyContext = resolveReplyContext_(profile && profile.phone, replyToKey);

    sh.appendRow([
      ts,
      profile.phone || '',
      profile.parentName || '',
      profile.childName || '',
      side || '',
      type || 'text',
      text || '',
      fileId || '',
      deleteAfter || '',
      status || 'active',
      readByParent,
      readByEducator,
      '',
      replyContext ? JSON.stringify(replyContext) : ''
    ]);

    upsertChatIndexFromMessage_(
      profile,
      side,
      type,
      text,
      ts,
      readByParent,
      readByEducator,
      status
    );

    clearGetChatMessagesCache(profile && profile.phone);

    return {
      messageKey: buildMessageKey_(ts, side),
      timestamp: humanTime_(ts),
      side: side || '',
      type: type || 'text',
      text: text || '',
      fileId: fileId || '',
      reply: replyContext
    };
  });
}

function buildVideoPayload_(videoUrl, videoTitle, caption) {
  return JSON.stringify({
    videoUrl: String(videoUrl || '').trim(),
    videoTitle: String(videoTitle || '').trim(),
    caption: String(caption || '').trim()
  });
}

function parseVideoPayload_(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return { videoUrl: '', videoTitle: '', caption: '' };

  try {
    const parsed = JSON.parse(raw);
    return {
      videoUrl: String(parsed.videoUrl || '').trim(),
      videoTitle: String(parsed.videoTitle || '').trim(),
      caption: String(parsed.caption || '').trim()
    };
  } catch (_) {
    // Backward compatibility for old token format: [▶ title|url|thumbnailUrl]
    const m = raw.match(/\[▶\s*([^\|\[\]\n]+)\|(https?:\/\/[^\s\]|]+)(?:\|https?:\/\/[^\s\]|]+)?\]/);
    if (m) {
      return {
        videoUrl: String(m[2] || '').trim(),
        videoTitle: String(m[1] || '').trim(),
        caption: raw.replace(m[0], '').trim()
      };
    }

    return { videoUrl: '', videoTitle: '', caption: raw };
  }
}

function buildDriveImageUrl_(fileId) {
  return fileId
    ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`
    : '';
}

function buildMessageKey_(ts, side) {
  const ms = new Date(ts).getTime();
  return String(ms) + '_' + String(side || '').trim();
}

function resolveReplyContext_(phoneRaw, messageKeyRaw) {
  const phone10 = last10_(phoneRaw);
  const messageKey = String(messageKeyRaw || '').trim();
  if (!phone10 || !messageKey) return null;

  const sh = ensureChatSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const targetMs = Number(messageKey.split('_')[0] || 0);
  let cursorEnd = lastRow;
  while (cursorEnd >= 2) {
    const firstRow = Math.max(2, cursorEnd - CHAT_SCAN_LIMIT + 1);
    const rows = sh.getRange(firstRow, 1, cursorEnd - firstRow + 1, 14).getValues();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const side = String(r[4] || '').trim();
      if (last10_(r[1]) !== phone10 || buildMessageKey_(r[0], side) !== messageKey) continue;
      const type = String(r[5] || '').trim() || 'text';
      let preview = buildChatPreviewText_(type, r[6]);
      if (type === 'video') {
        const video = parseVideoPayload_(r[6]);
        preview = video.caption || video.videoTitle || '[Видео]';
      }
      return {
        messageKey,
        side,
        type,
        text: String(preview || (type === 'image' ? '[Фотография]' : '[Сообщение]')).slice(0, 240)
      };
    }

    // CHAT_MESSAGES заполняется по времени. Если весь просмотренный пакет уже
    // старше целевого сообщения, дальше искать бессмысленно.
    const oldestMs = rows.length ? new Date(rows[0][0]).getTime() : 0;
    if (targetMs && oldestMs && oldestMs < targetMs) break;
    cursorEnd = firstRow - 1;
  }
  return null;
}

function upsertChatIndexFromMessage_(profile, side, type, text, ts, readByParent, readByEducator, status) {
  const indexSh = ensureChatIndexSheet_();
  const phone = normalizePhone_(profile && profile.phone ? profile.phone : '');
  const phone10 = last10_(phone);
  if (!phone10) return;

  const baseUnreadParent = side === 'educator';
  const baseUnreadEducator = side === 'parent';

  const rowValues = [
    phone,
    phone10,
    profile.parentName || '',
    profile.childName || '',
    ts || new Date(),
    side || '',
    buildChatPreviewText_(type, text),
    baseUnreadParent,
    baseUnreadEducator,
    status || 'active',
    readByParent || false,
    readByEducator || false
  ];

  const lastRow = indexSh.getLastRow();
  if (lastRow < 2) {
    indexSh.getRange(2, 1, 1, rowValues.length).setValues([rowValues]);
    return;
  }

  const phoneValues = indexSh.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  const rowIndexes = [];
  phoneValues.forEach((v, i) => {
    if (last10_(v) === phone10) rowIndexes.push(i);
  });
  const rowIndex = rowIndexes.length ? rowIndexes[0] : -1;

  if (rowIndex === -1) {
    indexSh.getRange(lastRow + 1, 1, 1, rowValues.length).setValues([rowValues]);
    return;
  }

  for (let i = rowIndexes.length - 1; i >= 1; i--) {
    indexSh.deleteRow(rowIndexes[i] + 2);
  }

  const existing = indexSh.getRange(rowIndex + 2, 1, 1, 12).getValues()[0];
  // Если это новое сообщение от воспитателя, родитель видит непрочитанное
  const nextUnreadParent = side === 'educator' ? true : String(existing[7]).toLowerCase() === 'true';
  // Если это новое сообщение от родителя, воспитатель видит непрочитанное
  const nextUnreadEducator = side === 'parent' ? true : String(existing[8]).toLowerCase() === 'true';
  // Preserve read_by flags from existing row
  const nextReadByParent = existing[10] === true || String(existing[10]).toLowerCase() === 'true';
  const nextReadByEducator = existing[11] === true || String(existing[11]).toLowerCase() === 'true';

  indexSh.getRange(rowIndex + 2, 1, 1, 12).setValues([[
    rowValues[0],
    rowValues[1],
    rowValues[2],
    rowValues[3],
    rowValues[4],
    rowValues[5],
    rowValues[6],
    nextUnreadParent,
    nextUnreadEducator,
    rowValues[9],
    nextReadByParent,
    nextReadByEducator
  ]]);
}

function setChatIndexReadFlag_(phoneRaw, columnIndex, value) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return;

  const indexSh = ensureChatIndexSheet_();
  const lastRow = indexSh.getLastRow();
  if (lastRow < 2) return;

  const phoneValues = indexSh.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  const rowIndex = phoneValues.findIndex(v => last10_(v) === phone10);
  if (rowIndex === -1) return;

  indexSh.getRange(rowIndex + 2, columnIndex, 1, 1).setValue(!!value);
}

function getChatIndexEntryByPhone_(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return null;

  const indexSh = ensureChatIndexSheet_();
  const lastRow = indexSh.getLastRow();
  if (lastRow < 2) return null;

  const rows = indexSh.getRange(2, 1, lastRow - 1, 12).getValues();
  for (const r of rows) {
    if (last10_(r[1]) !== phone10) continue;

    return {
      phone: normalizePhone_(r[0]),
      parentName: String(r[2] || '').trim(),
      childName: String(r[3] || '').trim()
    };
  }

  return null;
}

function getChatIndexUnreadFlag_(phoneRaw, columnIndex) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return null;

  const indexSh = ensureChatIndexSheet_();
  let lastRow = indexSh.getLastRow();

  if (lastRow < 2) {
    rebuildChatIndex_();
    lastRow = indexSh.getLastRow();
  }

  if (lastRow < 2) return false;

  const width = Math.max(1, columnIndex - 1);
  const rows = indexSh.getRange(2, 2, lastRow - 1, width).getValues(); // B:target
  const valueOffset = columnIndex - 2;

  for (const r of rows) {
    if (last10_(r[0]) !== phone10) continue;
    return r[valueOffset] === true || String(r[valueOffset]).toLowerCase() === 'true';
  }

  return null;
}

function buildLatestChatIndexItems_(rows) {
  const byPhone = {};

  rows.forEach(r => {
    const phone = String(r[0] || '').trim();
    const phone10 = String(r[1] || '').trim() || last10_(phone);
    if (!phone || !phone10) return;

    const tsMs = r[4] instanceof Date ? r[4].getTime() : new Date(r[4]).getTime();
    const item = {
      phone,
      phone10,
      parentName: String(r[2] || '').trim(),
      childName: String(r[3] || '').trim(),
      tsMs: Number.isFinite(tsMs) ? tsMs : 0,
      lastSide: String(r[5] || '').trim(),
      lastText: String(r[6] || '').trim(),
      hasUnreadParent: String(r[7]).toLowerCase() === 'true',
      hasUnreadEducator: String(r[8]).toLowerCase() === 'true',
      readByParent: r[10] === true || String(r[10]).toLowerCase() === 'true',
      readByEducator: r[11] === true || String(r[11]).toLowerCase() === 'true',
      status: String(r[9] || '').trim() || 'active'
    };

    const previous = byPhone[phone10];
    if (!previous || item.tsMs >= previous.tsMs) {
      byPhone[phone10] = item;
    }
  });

  return Object.values(byPhone);
}

function getChatProfileByPhone_(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return null;

  const activeProfile = getProfileByPhone_(phoneRaw);
  if (activeProfile) return activeProfile;

  const sh = getDataSheet_();
  if (sh) {
    const lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      const values = sh.getRange(2, 1, lastRow - 1, 7).getValues();
      for (const r of values) {
        if (last10_(r[0]) === phone10) {
          return buildProfileFromReportRow_(r);
        }
      }
    }
  }

  const indexProfile = getChatIndexEntryByPhone_(phone10);
  if (indexProfile) return indexProfile;

  const latestRows = getChatRowsForPhone_(phone10, '', 1).rows;
  if (latestRows.length) {
    const r = latestRows[latestRows.length - 1];
    return {
      phone: normalizePhone_(r[1]),
      parentName: String(r[2] || '').trim(),
      childName: String(r[3] || '').trim()
    };
  }

  return {
    phone: normalizePhone_(phoneRaw),
    parentName: '',
    childName: ''
  };
}

function listParentChats(tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const userCache = CacheService.getUserCache();
    const scriptCache = CacheService.getScriptCache();
    const cacheKey = 'listParentChats_result';
    const cached = userCache.get(cacheKey) || scriptCache.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const sh = ensureChatIndexSheet_();
    const lastRow = sh.getLastRow();

    if (lastRow < 2) {
      rebuildChatIndex_();
    }

    const freshLastRow = sh.getLastRow();
    if (freshLastRow < 2) return { ok: true, chats: [] };

    const rows = sh.getRange(2, 1, freshLastRow - 1, 12).getValues();
    const activePhones = getActiveReportPhonesSet_();

    const chats = buildLatestChatIndexItems_(rows)
      .map(x => ({
        ...x,
        hasUnread: x.hasUnreadParent
      }))
      .filter(x => x.phone && x.phone10 && x.status !== 'deleted' && activePhones.has(x.phone10))
      .sort((a, b) => b.tsMs - a.tsMs) // Sort by timestamp only
      .map(x => ({
        phone: x.phone,
        parentName: x.parentName,
        childName: x.childName,
        lastSide: x.lastSide,
        lastText: x.lastText,
        hasUnread: x.hasUnread
      }));

    // Cache for 3 seconds - enough to absorb bursts, but still feel live.
    const payload = JSON.stringify({ ok: true, chats });
    userCache.put(cacheKey, payload, 3);
    scriptCache.put(cacheKey, payload, 3);

    return { ok: true, chats };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки списка чатов: ' + (e.message || e) };
  }
}

function listUnreadParentChats(tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const userCache = CacheService.getUserCache();
    const scriptCache = CacheService.getScriptCache();
    const cacheKey = 'listUnreadParentChats_result';
    const cached = userCache.get(cacheKey) || scriptCache.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const sh = ensureChatIndexSheet_();
    const lastRow = sh.getLastRow();

    if (lastRow < 2) {
      rebuildChatIndex_();
    }

    const freshLastRow = sh.getLastRow();
    if (freshLastRow < 2) return { ok: true, chats: [] };

    const rows = sh.getRange(2, 1, freshLastRow - 1, 12).getValues();
    const activePhones = getActiveReportPhonesSet_();
    const pins = getEducatorChatPins_();

    const chats = buildLatestChatIndexItems_(rows)
      .filter(x => x.phone && x.phone10 && x.status !== 'deleted' && activePhones.has(x.phone10) &&
        (x.hasUnreadEducator || pins[x.phone10] === 'unread'))
      .sort((a, b) => {
        const pinDiff = Number(pins[b.phone10] === 'unread') - Number(pins[a.phone10] === 'unread');
        return pinDiff || b.tsMs - a.tsMs;
      })
      .map(x => ({
        phone: x.phone,
        parentName: x.parentName,
        childName: x.childName,
        lastSide: x.lastSide,
        lastText: x.lastText,
        hasUnread: x.hasUnreadEducator,
        pinnedBucket: pins[x.phone10] || ''
      }));

    const payload = JSON.stringify({ ok: true, chats });
    userCache.put(cacheKey, payload, 3);
    scriptCache.put(cacheKey, payload, 3);

    return { ok: true, chats };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки непрочитанных чатов: ' + (e.message || e) };
  }
}

function listReadParentChats(tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const userCache = CacheService.getUserCache();
    const scriptCache = CacheService.getScriptCache();
    const cacheKey = 'listReadParentChats_result';
    const cached = userCache.get(cacheKey) || scriptCache.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const sh = ensureChatIndexSheet_();
    const lastRow = sh.getLastRow();

    if (lastRow < 2) {
      rebuildChatIndex_();
    }

    const freshLastRow = sh.getLastRow();
    if (freshLastRow < 2) return { ok: true, chats: [] };

    const rows = sh.getRange(2, 1, freshLastRow - 1, 12).getValues();
    const activePhones = getActiveReportPhonesSet_();
    const pins = getEducatorChatPins_();

    const chats = buildLatestChatIndexItems_(rows)
      .filter(x => x.phone && x.phone10 && x.status !== 'deleted' && activePhones.has(x.phone10) &&
        (!x.hasUnreadEducator || pins[x.phone10] === 'read'))
      .sort((a, b) => {
        const pinDiff = Number(pins[b.phone10] === 'read') - Number(pins[a.phone10] === 'read');
        return pinDiff || b.tsMs - a.tsMs;
      })
      .map(x => ({
        phone: x.phone,
        parentName: x.parentName,
        childName: x.childName,
        lastSide: x.lastSide,
        lastText: x.lastText,
        hasUnread: x.hasUnreadEducator,
        pinnedBucket: pins[x.phone10] || ''
      }));

    const payload = JSON.stringify({ ok: true, chats });
    userCache.put(cacheKey, payload, 3);
    scriptCache.put(cacheKey, payload, 3);

    return { ok: true, chats };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки прочитанных чатов: ' + (e.message || e) };
  }
}

function hasUnreadParentChats(tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const sh = ensureChatIndexSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: true, hasUnread: false };

    const rows = sh.getRange(2, 1, lastRow - 1, 12).getValues();

    const hasUnread = rows.some(r => {
      // Column I (index 8) = HAS_UNREAD_EDUCATOR (new messages from parent FOR educator)
      const hasUnreadEducator = String(r[8]).toLowerCase() === 'true';
      const status = String(r[9] || '').trim().toLowerCase();

      return hasUnreadEducator && status === 'active';
    });

    return { ok: true, hasUnread };
  } catch (e) {
    return {
      ok: false,
      hasUnread: false,
      message: 'Ошибка проверки новых сообщений: ' + (e.message || e)
    };
  }
}

function buildChatMessageFromRow_(r) {
  const ts     = r[0];
  const side   = String(r[4] || '').trim();
  const type   = String(r[5] || '').trim() || 'text';
  const textCell = String(r[6] || '').trim();
  const fileId = String(r[7] || '').trim();
  const reaction = normalizeReaction_(r[12] || '');
  const reply = parseReplyContext_(r[13]);

  const readByParent   = r[10] === true || String(r[10]).toLowerCase() === 'true';
  const readByEducator = r[11] === true || String(r[11]).toLowerCase() === 'true';

  let mediaUrl = '';
  let videoUrl = '';
  let videoTitle = '';
  let text = textCell;

  if (fileId) {
    if (type === 'image') {
      mediaUrl = buildDriveImageUrl_(fileId);
    } else if (type === 'video') {
      mediaUrl = buildDriveImageUrl_(fileId);
    }
  }

  if (type === 'video') {
    const parsedVideo = parseVideoPayload_(textCell);
    videoUrl = parsedVideo.videoUrl;
    videoTitle = parsedVideo.videoTitle;
    text = parsedVideo.caption;
  }

  return {
    messageKey: buildMessageKey_(ts, side),
    side,
    type,
    text,
    mediaUrl,
    videoUrl,
    videoTitle,
    parentName: String(r[2] || '').trim(),
    childName: String(r[3] || '').trim(),
    timestamp: humanTime_(ts),
    readByParent,
    readByEducator,
    reaction,
    reply
  };
}

function getChatRowsForPhone_(phoneRaw, beforeKeyRaw, limitRaw) {
  const phone10 = last10_(phoneRaw);
  const beforeKey = String(beforeKeyRaw || '').trim();
  const limit = Math.max(1, Number(limitRaw) || CHAT_THREAD_INITIAL_LIMIT);
  const sh = ensureChatSheet_();
  const lastRow = sh.getLastRow();

  if (!phone10 || lastRow < 2) {
    return { rows: [], hasMore: false };
  }

  const firstDataRow = 2;
  const batchSize = Math.max(CHAT_SCAN_LIMIT, limit * 6);
  const collected = [];
  let hasMore = false;
  let seenBeforeKey = !beforeKey;
  let cursorEnd = lastRow;

  while (cursorEnd >= firstDataRow && collected.length < limit + 1) {
    const batchStart = Math.max(firstDataRow, cursorEnd - batchSize + 1);
    const batchRows = cursorEnd - batchStart + 1;
    const rows = sh.getRange(batchStart, 1, batchRows, 14).getValues();

    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (last10_(r[1]) !== phone10) continue;

      const rowKey = buildMessageKey_(r[0], String(r[4] || '').trim());
      if (!seenBeforeKey) {
        if (rowKey === beforeKey) {
          seenBeforeKey = true;
        }
        continue;
      }

      collected.push(r);
      if (collected.length > limit) {
        hasMore = true;
        break;
      }
    }

    cursorEnd = batchStart - 1;
  }

  if (!seenBeforeKey && beforeKey) {
    return getChatRowsForPhone_(phone10, '', limit);
  }

  if (collected.length > limit) {
    collected.length = limit;
  }

  collected.reverse();
  return { rows: collected, hasMore };
}

function getChatMessages(phoneRaw, options, tutorTokenRaw) {
  // A one-argument educator call is also supported: getChatMessages(phone, token).
  if (typeof options === 'string' && tutorTokenRaw === undefined) {
    tutorTokenRaw = options;
    options = {};
  }
  requireTutorSession_(tutorTokenRaw);
  return getChatMessagesCore_(phoneRaw, options);
}

function getChatMessagesCore_(phoneRaw, options) {
  try {
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok: false, message: 'Некорректный номер телефона.' };

    options = options || {};
    const beforeKey = String(options.beforeKey || '').trim();
    const limitRaw = Number(options.limit || (beforeKey ? CHAT_THREAD_OLDER_LIMIT : CHAT_THREAD_INITIAL_LIMIT));
    const limit = Math.max(1, Math.min(150, Number.isFinite(limitRaw) ? limitRaw : CHAT_THREAD_INITIAL_LIMIT));
    const isClosed = !isPhoneActiveInReports_(phone10);

    const cache = CacheService.getUserCache();
    const cacheKey = 'getChatMessages_' + phone10 + '_' + (beforeKey || 'latest') + '_' + limit;
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const profile = getChatProfileByPhone_(phoneRaw);
    const page = getChatRowsForPhone_(phone10, beforeKey, limit);
    const messages = page.rows.map(buildChatMessageFromRow_);

    const result = {
      ok: true,
      phone: profile ? profile.phone : normalizePhone_(phoneRaw),
      parentName: profile ? profile.parentName : '',
      childName: profile ? profile.childName : '',
      messages,
      hasMore: !!page.hasMore,
      closed: isClosed
    };

    cache.put(cacheKey, JSON.stringify(result), 1);

    return result;

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки чата: ' + (e.message || e) };
  }
}

function getParentChatMessages(phoneRaw, options, parentSessionRaw) {
  requireParentAccess_(phoneRaw, parentSessionRaw);
  return getChatMessagesCore_(phoneRaw, options);
}

function getOlderParentChatMessages(phoneRaw, beforeKeyRaw, parentSessionRaw) {
  return getParentChatMessages(phoneRaw, {
    beforeKey: beforeKeyRaw,
    limit: CHAT_THREAD_OLDER_LIMIT
  }, parentSessionRaw);
}

function getOlderChatMessages(phoneRaw, beforeKeyRaw, tutorTokenRaw) {
  requireTutorSession_(tutorTokenRaw);
  return getChatMessagesCore_(phoneRaw, {
    beforeKey: beforeKeyRaw,
    limit: CHAT_THREAD_OLDER_LIMIT
  });
}

function setChatMessageReaction(phoneRaw, messageKeyRaw, reactionRaw) {
  try {
    const phone10 = last10_(phoneRaw);
    const messageKey = String(messageKeyRaw || '').trim();
    const reaction = normalizeReaction_(reactionRaw);

    if (!phone10) return { ok: false, message: 'Некорректный номер телефона.' };
    if (!messageKey) return { ok: false, message: 'Не найдено сообщение для реакции.' };

    const sh = ensureChatSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'Сообщения не найдены.' };

    const startRow = 2;
    const rows = sh.getRange(startRow, 1, lastRow - startRow + 1, 13).getValues();

    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const rowPhone10 = last10_(r[1]);
      const rowSide = String(r[4] || '').trim();
      const rowKey = buildMessageKey_(r[0], rowSide);

      if (rowPhone10 !== phone10) continue;
      if (rowKey !== messageKey) continue;

      const currentReaction = normalizeReaction_(r[12] || '');

      const nextReaction = (currentReaction === reaction) ? '' : reaction;

      // rows are loaded from startRow, so the sheet row index is offset
      sh.getRange(startRow + i, 13).setValue(nextReaction);
      clearGetChatMessagesCache(phoneRaw);

      return { ok: true, reaction: nextReaction };
    }

    return { ok: false, message: 'Сообщение для реакции не найдено.' };

  } catch (e) {
    return { ok: false, message: 'Ошибка сохранения реакции: ' + (e.message || e) };
  }
}

function deleteMessage(phoneRaw, messageKeyRaw, actorSideRaw, tutorTokenRaw) {
  try {
    const phone10 = last10_(phoneRaw);
    const messageKey = String(messageKeyRaw || '').trim();
    const actorSide = String(actorSideRaw || 'educator').trim().toLowerCase();

    if (actorSide === 'educator') requireTutorSession_(tutorTokenRaw);

    if (!phone10) return { ok: false, message: 'Некорректный номер телефона.' };
    if (!messageKey) return { ok: false, message: 'Не найдено сообщение для удаления.' };
    if (!['parent', 'educator'].includes(actorSide)) return { ok: false, message: 'Некорректная сторона чата.' };

    if (!isPhoneActiveInReports_(phone10)) {
      return { ok: false, message: 'Чат больше недоступен.' };
    }

    const sh = ensureChatSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'Сообщение не найдено.' };

    const startRow = 2;
    const rows = sh.getRange(startRow, 1, lastRow - startRow + 1, 13).getValues();

    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const rowPhone10 = last10_(r[1]);
      const rowSide = String(r[4] || '').trim();
      const rowKey = buildMessageKey_(r[0], rowSide);

      if (rowPhone10 !== phone10) continue;
      if (rowKey !== messageKey) continue;
      if (rowSide !== actorSide) {
        return { ok: false, message: 'Можно удалять только свои сообщения.' };
      }

      sh.deleteRow(startRow + i);

      rebuildChatIndex_();

      clearGetChatMessagesCache(phoneRaw);
      return { ok: true, message: 'Сообщение удалено.' };
    }

    return { ok: false, message: 'Сообщение не найдено.' };

  } catch (e) {
    return { ok: false, message: 'Ошибка удаления сообщения: ' + (e.message || e) };
  }
}

function updateMessage(phoneRaw, messageKeyRaw, newTextRaw, actorSideRaw, tutorTokenRaw) {
  try {
    const phone10 = last10_(phoneRaw);
    const messageKey = String(messageKeyRaw || '').trim();
    const newText = cleanIncomingText_(newTextRaw);
    const actorSide = String(actorSideRaw || 'educator').trim().toLowerCase();

    if (actorSide === 'educator') requireTutorSession_(tutorTokenRaw);

    if (!phone10) return { ok: false, message: 'Некорректный номер телефона.' };
    if (!messageKey) return { ok: false, message: 'Не найдено сообщение для редактирования.' };
    if (!newText) return { ok: false, message: 'Пустой текст.' };
    if (!['parent', 'educator'].includes(actorSide)) return { ok: false, message: 'Некорректная сторона чата.' };

    if (!isPhoneActiveInReports_(phone10)) {
      return { ok: false, message: 'Чат больше недоступен.' };
    }

    const sh = ensureChatSheet_();
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { ok: false, message: 'Сообщение не найдено.' };

    const startRow = 2;
    const rows = sh.getRange(startRow, 1, lastRow - startRow + 1, 13).getValues();

    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const rowPhone10 = last10_(r[1]);
      const rowSide = String(r[4] || '').trim();
      const rowKey = buildMessageKey_(r[0], rowSide);

      if (rowPhone10 !== phone10) continue;
      if (rowKey !== messageKey) continue;

      if (rowSide !== actorSide) {
        return { ok: false, message: 'Можно редактировать только свои сообщения.' };
      }

      sh.getRange(startRow + i, 7).setValue(newText);

      rebuildChatIndex_();

      clearGetChatMessagesCache(phoneRaw);
      return { ok: true, message: 'Сообщение обновлено.' };
    }

    return { ok: false, message: 'Сообщение не найдено.' };

  } catch (e) {
    return { ok: false, message: 'Ошибка редактирования сообщения: ' + (e.message || e) };
  }
}

function uploadEducatorChatImage(phoneRaw, fileName, mimeType, base64Data, textRaw, replyToKeyRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    if (!isPhoneActiveInReports_(phoneRaw)) {
      return { ok: false, message: 'Чат больше недоступен.' };
    }

    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Не удалось определить чат.' };
    }

    if (!base64Data || !mimeType) {
      return { ok: false, message: 'Файл не получен.' };
    }

    if (!/^image\//i.test(mimeType)) {
      return { ok: false, message: 'Можно загружать только фото.' };
    }

    const bytes = Utilities.base64Decode(base64Data);
    const safeName = String(fileName || 'image')
      .replace(/[^\wа-яА-ЯёЁ.\- ]/g, '_')
      .trim() || 'image';

    const blob = Utilities.newBlob(bytes, mimeType, safeName);
    const folder = getChatPhotosFolder_();
    const file = folder.createFile(blob);

    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const deleteAfter = new Date(Date.now() + CHAT_IMAGE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const text = cleanIncomingText_(textRaw);

    const appended = appendChatMessage_(
      profile,
      'educator',
      'image',
      text,
      file.getId(),
      deleteAfter,
      'active',
      replyToKeyRaw
    );
    const pushClient = notifyNewChatMessage_(profile, 'educator', 'image', text);

    ensureChatCleanupTrigger_();
    clearGetChatMessagesCache(phoneRaw);

    return {
      ok: true,
      url: buildDriveImageUrl_(file.getId()),
      type: 'image',
      messageKey: appended.messageKey,
      timestamp: appended.timestamp,
      pushClient
    };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки файла: ' + (e.message || e) };
  }
}

function uploadEducatorVideoThumbnail(phoneRaw, fileName, mimeType, base64Data, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    if (!isPhoneActiveInReports_(phoneRaw)) {
      return { ok: false, message: 'Чат больше недоступен.' };
    }

    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Не удалось определить чат.' };
    }

    if (!base64Data || !mimeType) {
      return { ok: false, message: 'Файл не получен.' };
    }

    const isImage = /^image\//i.test(mimeType);
    const isVideo = /^video\//i.test(mimeType);

    if (!isImage && !isVideo) {
      return { ok: false, message: 'Можно загружать только фото или короткое видео.' };
    }

    const bytes = Utilities.base64Decode(base64Data);
    const safeName = String(fileName || 'video_thumbnail')
      .replace(/[^\wа-яА-ЯёЁ.\- ]/g, '_')
      .trim() || 'video_thumbnail';

    const blob = Utilities.newBlob(bytes, mimeType, safeName);
    const folder = getChatPhotosFolder_();
    const file = folder.createFile(blob);

    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return {
      ok: true,
      url: buildDriveImageUrl_(file.getId()),
      fileId: file.getId()
    };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки обложки: ' + (e.message || e) };
  }
}

function sendEducatorVideoMessage(phoneRaw, videoUrlRaw, videoTitleRaw, thumbnailFileIdRaw, captionRaw, replyToKeyRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    if (!isPhoneActiveInReports_(phoneRaw)) {
      return { ok: false, message: 'Диалог с родителем был закрыт.' };
    }

    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Не удалось определить чат по номеру телефона.' };
    }

    const videoUrl = String(videoUrlRaw || '').trim();
    const videoTitle = String(videoTitleRaw || '').trim();
    const thumbnailFileId = String(thumbnailFileIdRaw || '').trim();
    const caption = cleanIncomingText_(captionRaw);

    if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
      return { ok: false, message: 'Укажите корректную ссылку на видео.' };
    }

    const payload = buildVideoPayload_(videoUrl, videoTitle, caption);

    const appended = appendChatMessage_(
      profile,
      'educator',
      'video',
      payload,
      thumbnailFileId,
      '',
      'active',
      replyToKeyRaw
    );
    const pushClient = notifyNewChatMessage_(profile, 'educator', 'video', payload);

    clearGetChatMessagesCache(phoneRaw);

    return {
      ok: true,
      type: 'video',
      videoUrl,
      videoTitle,
      caption,
      thumbnailUrl: thumbnailFileId ? buildDriveImageUrl_(thumbnailFileId) : '',
      messageKey: appended.messageKey,
      timestamp: appended.timestamp,
      pushClient
    };
  } catch (e) {
    return { ok: false, message: 'Ошибка отправки видео: ' + (e.message || e) };
  }
}

function uploadParentChatImage(phoneRaw, fileName, mimeType, base64Data, textRaw, replyToKeyRaw, parentSessionRaw) {
  try {
    requireParentAccess_(phoneRaw, parentSessionRaw);
    if (!isPhoneActiveInReports_(phoneRaw)) {
      return { ok: false, message: 'Чат больше недоступен.' };
    }

    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) {
      return { ok: false, message: 'Ваш номер не найден в системе.' };
    }

    if (!base64Data || !mimeType) {
      return { ok: false, message: 'Файл не получен.' };
    }

    if (!/^image\//i.test(mimeType)) {
      return { ok: false, message: 'Можно загружать только фото.' };
    }

    const bytes = Utilities.base64Decode(base64Data);
    const safeName = String(fileName || 'image')
      .replace(/[^\wа-яА-ЯёЁ.\- ]/g, '_')
      .trim() || 'image';

    const blob = Utilities.newBlob(bytes, mimeType, safeName);
    const folder = getChatPhotosFolder_();
    const file = folder.createFile(blob);

    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const deleteAfter = new Date(Date.now() + CHAT_IMAGE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const text = cleanIncomingText_(textRaw);

    const appended = appendChatMessage_(
      profile,
      'parent',
      'image',
      text,
      file.getId(),
      deleteAfter,
      'active',
      replyToKeyRaw
    );
    const pushClient = notifyNewChatMessage_(profile, 'parent', 'image', text);

    ensureChatCleanupTrigger_();
    clearGetChatMessagesCache(phoneRaw);

    return {
      ok: true,
      url: buildDriveImageUrl_(file.getId()),
      type: 'image',
      messageKey: appended.messageKey,
      timestamp: appended.timestamp,
      pushClient
    };

  } catch (e) {
    return { ok: false, message: 'Ошибка загрузки файла: ' + (e.message || e) };
  }
}

function uploadChatAttachmentForD1(phoneRaw, fileName, mimeType, base64Data, roleRaw, tutorTokenRaw) {
  try {
    const role = String(roleRaw || '').trim().toLowerCase();
    if (!['parent', 'educator'].includes(role)) return { ok:false, message:'Некорректная роль.' };
    if (role === 'educator') requireTutorSession_(tutorTokenRaw);
    if (!isPhoneActiveInReports_(phoneRaw)) return { ok:false, message:'Чат больше недоступен.' };
    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) return { ok:false, message:'Чат не найден.' };
    if (!base64Data || !/^image\//i.test(String(mimeType || ''))) return { ok:false, message:'Можно загружать только фото.' };
    const safeName = String(fileName || 'image').replace(/[^\wа-яА-ЯёЁ.\- ]/g, '_').trim() || 'image';
    const file = getChatPhotosFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, safeName));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    ensureChatCleanupTrigger_();
    return { ok:true, fileId:file.getId(), url:buildDriveImageUrl_(file.getId()), deleteAfter:Date.now() + CHAT_IMAGE_TTL_DAYS * 86400000 };
  } catch (e) { return { ok:false, message:'Ошибка загрузки файла: ' + (e.message || e) }; }
}

function notifyD1ChatMessage(phoneRaw, roleRaw, typeRaw, textRaw, tutorTokenRaw) {
  try {
    const role = String(roleRaw || '').trim().toLowerCase();
    if (!['parent', 'educator'].includes(role)) return { ok:false, message:'Некорректная роль.' };
    if (role === 'educator') requireTutorSession_(tutorTokenRaw);
    const profile = getProfileByPhone_(phoneRaw);
    if (!profile || !profile.phone) return { ok:false, message:'Чат не найден.' };
    const push = notifyNewChatMessage_(profile, role, String(typeRaw || 'text'), String(textRaw || ''));
    return { ok:true, pushClient:push && push.fallback ? push.fallback : push };
  } catch (e) { return { ok:false, message:'Ошибка уведомления: ' + (e.message || e) }; }
}

function markParentMessagesAsReadByEducator(phoneRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok: false };

    return withChatWriteLock_(function() {
      // Always repair the source rows too. The index can be stale after an
      // interrupted or older concurrent execution and must not short-circuit this write.
      markChatMessagesRead_(phone10, 'parent', 12);
      setChatIndexReadFlag_(phone10, 9, false);
      setChatIndexReadFlag_(phone10, 12, true);
      clearGetChatMessagesCache(phoneRaw);
      return { ok: true };
    });

  } catch (e) {
    return { ok: false, message: 'Ошибка отметки сообщений воспитателем: ' + (e.message || e) };
  }
}

function markParentMessagesAsUnreadByEducator(phoneRaw, tutorTokenRaw) {
  try {
    requireTutorSession_(tutorTokenRaw);
    const phone10 = last10_(phoneRaw);
    if (!phone10) return { ok: false };

    return withChatWriteLock_(function() {
      const updated = markChatMessagesReadValue_(phone10, 'parent', 12, false);
      if (updated > 0) {
        setChatIndexReadFlag_(phone10, 9, true);
        setChatIndexReadFlag_(phone10, 12, false);
      }
      clearGetChatMessagesCache(phoneRaw);
      return { ok: true, updated };
    });

  } catch (e) {
    return { ok: false, message: 'Ошибка возврата чата в непрочитанные: ' + (e.message || e) };
  }
}

function markChatMessagesRead_(phoneRaw, sideToMark, readColumnIndex) {
  return markChatMessagesReadValue_(phoneRaw, sideToMark, readColumnIndex, true);
}

function markChatMessagesReadValue_(phoneRaw, sideToMark, readColumnIndex, value) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return 0;

  const sh = ensureChatSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const startRow = 2;
  const rows = sh.getRange(startRow, 2, lastRow - startRow + 1, 11).getValues(); // B:L
  const targetRows = [];
  const readValueIndex = readColumnIndex - 2;
  const nextValue = !!value;

  rows.forEach((r, idx) => {
    const rowPhone10 = last10_(r[0]);
    const side = String(r[3] || '').trim();
    const currentValue = r[readValueIndex] === true || String(r[readValueIndex]).toLowerCase() === 'true';

    if (rowPhone10 === phone10 && side === sideToMark && currentValue !== nextValue) {
      targetRows.push(startRow + idx);
    }
  });

  if (!targetRows.length) return 0;

  let rangeStart = targetRows[0];
  let rangeLength = 1;
  let updated = 0;

  for (let i = 1; i <= targetRows.length; i++) {
    const row = targetRows[i];
    if (row === targetRows[i - 1] + 1) {
      rangeLength += 1;
      continue;
    }

    sh.getRange(rangeStart, readColumnIndex, rangeLength, 1).setValue(nextValue);
    updated += rangeLength;
    rangeStart = row;
    rangeLength = 1;
  }

  return updated;
}

/* Retired spreadsheet storage and cleanup layer. */
function getChatSheet_() {
  return getSheet_(CHAT_SHEET_NAME);
}

function ensureChatSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CHAT_SHEET_NAME);

  const headers = [[
    'TIMESTAMP',
    'PHONE',
    'PARENT_NAME',
    'CHILD_NAME',
    'SIDE',
    'TYPE',
    'TEXT',
    'FILE_ID',
    'DELETE_AFTER',
    'STATUS',
    'READ_BY_PARENT',
    'READ_BY_EDUCATOR',
    'MESSAGE_REACTION',
    'REPLY_CONTEXT'
  ]];

  if (!sh) {
    sh = ss.insertSheet(CHAT_SHEET_NAME);
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
    return sh;
  }

  const lastCol = sh.getLastColumn();
  const currentHeaders = lastCol > 0
    ? sh.getRange(1, 1, 1, Math.max(lastCol, headers[0].length)).getValues()[0]
    : [];

  const needRewrite =
    currentHeaders.length < headers[0].length ||
    String(currentHeaders[0] || '') !== 'TIMESTAMP' ||
    String(currentHeaders[5] || '') !== 'TYPE' ||
    String(currentHeaders[10] || '') !== 'READ_BY_PARENT' ||
    String(currentHeaders[11] || '') !== 'READ_BY_EDUCATOR' ||
    String(currentHeaders[12] || '') !== 'MESSAGE_REACTION' ||
    String(currentHeaders[13] || '') !== 'REPLY_CONTEXT';

  if (needRewrite) {
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
  }

  return sh;
}

function ensureChatIndexSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CHAT_INDEX_SHEET_NAME);

  const headers = [[
    'PHONE',
    'PHONE10',
    'PARENT_NAME',
    'CHILD_NAME',
    'LAST_TS',
    'LAST_SIDE',
    'LAST_TEXT',
    'HAS_UNREAD_PARENT',
    'HAS_UNREAD_EDUCATOR',
    'STATUS',
    'READ_BY_PARENT',
    'READ_BY_EDUCATOR'
  ]];

  if (!sh) {
    sh = ss.insertSheet(CHAT_INDEX_SHEET_NAME);
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
    return sh;
  }

  const lastCol = sh.getLastColumn();
  const currentHeaders = lastCol > 0
    ? sh.getRange(1, 1, 1, Math.max(lastCol, headers[0].length)).getValues()[0]
    : [];

  const needRewrite =
    currentHeaders.length < headers[0].length ||
    String(currentHeaders[0] || '') !== 'PHONE' ||
    String(currentHeaders[1] || '') !== 'PHONE10' ||
    String(currentHeaders[7] || '') !== 'HAS_UNREAD_PARENT' ||
    String(currentHeaders[10] || '') !== 'READ_BY_PARENT' ||
    String(currentHeaders[11] || '') !== 'READ_BY_EDUCATOR' ||
    String(currentHeaders[8] || '') !== 'HAS_UNREAD_EDUCATOR';

  if (needRewrite) {
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
  }

  return sh;
}

function ensureChatPinsSheet_() {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(CHAT_PINS_SHEET_NAME);
  const headers = [['PHONE10', 'BUCKET', 'UPDATED_AT']];

  if (!sh) {
    sh = ss.insertSheet(CHAT_PINS_SHEET_NAME);
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
    sh.hideSheet();
    return sh;
  }

  if (sh.getLastColumn() < headers[0].length || String(sh.getRange(1, 1).getValue() || '') !== 'PHONE10') {
    sh.getRange(1, 1, 1, headers[0].length).setValues(headers);
  }
  return sh;
}

function removeEducatorChatPin_(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  if (!phone10) return;
  const sh = ensureChatPinsSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const values = sh.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  for (let i = values.length - 1; i >= 0; i--) {
    if (last10_(values[i]) === phone10) sh.deleteRow(i + 2);
  }
}

function purgeInactiveChatMessages_() {
  const sh = ensureChatSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, deletedRows: 0 };

  const reportPhones = new Set();
  const dataSh = getDataSheet_();

  if (dataSh) {
    const dataLastRow = dataSh.getLastRow();
    if (dataLastRow >= 2) {
      const phones = dataSh.getRange(2, 1, dataLastRow - 1, 1).getValues().flat();
      phones.forEach(v => {
        const p10 = last10_(v);
        if (p10) reportPhones.add(p10);
      });
    }
  }

  const rows = sh.getRange(2, 1, lastRow - 1, 12).getValues();
  const rowsToDelete = [];

  for (let i = 0; i < rows.length; i++) {
    const phone10 = last10_(rows[i][1]);
    if (!phone10 || !reportPhones.has(phone10)) {
      rowsToDelete.push(i + 2);
    }
  }

  for (let i = rowsToDelete.length - 1; i >= 0; i--) {
    sh.deleteRow(rowsToDelete[i]);
  }

  if (rowsToDelete.length > 0) {
    rebuildChatIndex_();
    clearGetChatMessagesCache();
  }

  return { ok: true, deletedRows: rowsToDelete.length };
}

function purgeLegacyChatMessagesForPhone_(phoneRaw) {
  const phone = last10_(phoneRaw);
  if (!phone) return { ok:true, deletedRows:0 };
  const sheet = ensureChatSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok:true, deletedRows:0 };
  const phones = sheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  const rows = [];
  phones.forEach(function(value, index) {
    if (last10_(value) === phone) rows.push(index + 2);
  });
  for (let i = rows.length - 1; i >= 0; i--) sheet.deleteRow(rows[i]);
  if (rows.length) {
    rebuildChatIndex_();
    clearGetChatMessagesCache(phone);
  }
  return { ok:true, deletedRows:rows.length };
}

function cleanupInactiveChatMessages() {
  return purgeInactiveChatMessages_();
}

function ensureInactiveChatCleanupTrigger_() {
  const handler = 'cleanupInactiveChatMessages';
  const triggers = ScriptApp.getProjectTriggers();
  const matching = triggers.filter(t => t.getHandlerFunction() === handler);
  matching.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
  if (matching.length) return;

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyHours(1)
    .create();
}

function ensureChatCleanupTrigger_() {
  const handler = 'cleanupExpiredChatImages';
  const triggers = ScriptApp.getProjectTriggers();
  const matching = triggers.filter(t => t.getHandlerFunction() === handler);
  matching.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
  if (matching.length) return;

  ScriptApp.newTrigger(handler)
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();
}

function rebuildChatIndex_() {
  const chatSh = ensureChatSheet_();
  const indexSh = ensureChatIndexSheet_();
  const lastRow = chatSh.getLastRow();

  if (lastRow < 2) {
    const existingLastRow = indexSh.getLastRow();
    if (existingLastRow > 1) {
      indexSh.getRange(2, 1, existingLastRow - 1, 12).clearContent();
    }
    return { ok: true, rows: 0 };
  }

  const rows = chatSh.getRange(2, 1, lastRow - 1, 14).getValues();
  const byPhone = {};

  // First pass: group messages by phone and collect all data
  rows.forEach(r => {
    const phone = normalizePhone_(r[1]);
    const phone10 = last10_(phone);
    if (!phone10) return;

    const parentName = String(r[2] || '').trim();
    const childName = String(r[3] || '').trim();
    const side = String(r[4] || '').trim();
    const type = String(r[5] || '').trim() || 'text';
    const text = String(r[6] || '').trim();
    const status = String(r[9] || '').trim() || 'active';
    const readByParent = r[10] === true || String(r[10]).toLowerCase() === 'true';
    const readByEducator = r[11] === true || String(r[11]).toLowerCase() === 'true';
    const tsMs = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();

    // Initialize or reuse entry
    if (!byPhone[phone10]) {
      byPhone[phone10] = {
        phone,
        phone10,
        parentName: parentName || '',
        childName: childName || '',
        lastTs: tsMs,
        lastSide: side,
        lastText: buildChatPreviewText_(type, text),
        status: status || 'active',
        hasUnreadParent: false,
        hasUnreadEducator: false,
        hasAnyMessages: false,
        messages: []
      };
    }

    // Update to more recent message info
    if (tsMs > byPhone[phone10].lastTs) {
      byPhone[phone10].lastTs = tsMs;
      byPhone[phone10].lastSide = side;
      byPhone[phone10].lastText = buildChatPreviewText_(type, text);
    }

    if (parentName) byPhone[phone10].parentName = parentName;
    if (childName) byPhone[phone10].childName = childName;
    if (status) byPhone[phone10].status = status;

    byPhone[phone10].hasAnyMessages = true;
    byPhone[phone10].messages.push({
      side: side,
      readByParent: readByParent,
      readByEducator: readByEducator
    });
  });

  // Second pass: determine unread status by checking ALL messages
  Object.keys(byPhone).forEach(phone10 => {
    const chat = byPhone[phone10];

    // Check if there are unread messages FROM parent (for educator)
    chat.hasUnreadEducator = chat.messages.some(msg => msg.side === 'parent' && !msg.readByEducator);

    // Check if there are unread messages FROM educator (for parent)
    chat.hasUnreadParent = chat.messages.some(msg => msg.side === 'educator' && !msg.readByParent);
  });

  const rowsToWrite = Object.values(byPhone)
    .filter(chat => chat.hasAnyMessages)
    .sort((a, b) => b.lastTs - a.lastTs)
    .map(item => [
      item.phone,
      item.phone10,
      item.parentName || '',
      item.childName || '',
      item.lastTs ? new Date(item.lastTs) : '',
      item.lastSide || '',
      item.lastText || '',
      item.hasUnreadParent ? true : false,
      item.hasUnreadEducator ? true : false,
      item.status || 'active',
      item.hasUnreadParent ? false : true,
      item.hasUnreadEducator ? false : true
    ]);

  const existingLastRow = indexSh.getLastRow();
  if (existingLastRow > 1) {
    indexSh.getRange(2, 1, existingLastRow - 1, 12).clearContent();
  }

  if (rowsToWrite.length > 0) {
    indexSh.getRange(2, 1, rowsToWrite.length, 12).setValues(rowsToWrite);
  }

  return { ok: true, rows: rowsToWrite.length };
}

function cleanupExpiredChatImages() {
  const sh = ensureChatSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const rows = sh.getRange(2, 1, lastRow - 1, 13).getValues();
  const now = Date.now();

  const rowsToDelete = [];
  const filesToDelete = [];

  for (let i = 0; i < rows.length; i++) {
    const type        = String(rows[i][5] || '').trim(); // TYPE
    const fileId      = String(rows[i][7] || '').trim(); // FILE_ID
    const deleteAfter = rows[i][8];                      // DELETE_AFTER

    if (type === 'image' && fileId && deleteAfter) {
      let deleteTs;

      if (typeof deleteAfter === 'string') {
        // Если строка, попробуем распарсить
        deleteTs = new Date(deleteAfter).getTime();
      } else if (deleteAfter instanceof Date) {
        deleteTs = deleteAfter.getTime();
      } else {
        // Попробуем расценить как число миллисекунд
        deleteTs = Number(deleteAfter) > 1e10 ? Number(deleteAfter) : new Date(deleteAfter).getTime();
      }

      if (!isNaN(deleteTs) && deleteTs <= now) {
        filesToDelete.push(fileId);
        rowsToDelete.push(i + 2); // +2 потому что данные начинаются со 2 строки
      }
    }
  }

  // Удаляем файлы из Drive
  for (const fileId of filesToDelete) {
    try {
      const file = DriveApp.getFileById(fileId);
      file.setTrashed(true);
    } catch (e) {
      // Файл уже удален или недоступен - это нормально
      Logger.log('File cleanup error for ' + fileId + ': ' + e.message);
    }
  }

  // Удаляем строки из таблицы в обратном порядке
  for (let i = rowsToDelete.length - 1; i >= 0; i--) {
    sh.deleteRow(rowsToDelete[i]);
  }

  if (rowsToDelete.length > 0) {
    rebuildChatIndex_();
    clearGetChatMessagesCache();
  }
}

function clearGetChatMessagesCache(phoneRaw) {
  const phone10 = last10_(phoneRaw);
  const userCache = CacheService.getUserCache();
  const scriptCache = CacheService.getScriptCache();

  if (phone10) {
    userCache.remove('getChatMessages_' + phone10);
    scriptCache.remove('getChatMessages_' + phone10);
    userCache.removeAll([
      'getChatMessages_' + phone10 + '_latest_' + CHAT_THREAD_INITIAL_LIMIT,
      'getChatMessages_' + phone10 + '_latest_' + CHAT_THREAD_OLDER_LIMIT
    ]);
    scriptCache.removeAll([
      'getChatMessages_' + phone10 + '_latest_' + CHAT_THREAD_INITIAL_LIMIT,
      'getChatMessages_' + phone10 + '_latest_' + CHAT_THREAD_OLDER_LIMIT
    ]);
  }

  userCache.remove('listParentChats_result');
  scriptCache.remove('listParentChats_result');
  userCache.remove('listUnreadParentChats_result');
  scriptCache.remove('listUnreadParentChats_result');
  userCache.remove('listReadParentChats_result');
  scriptCache.remove('listReadParentChats_result');
}
