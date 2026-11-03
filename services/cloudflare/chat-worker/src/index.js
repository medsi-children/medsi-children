// Identity grammar matches Apps Script medsi-contacts.js and parent-relationships.js.
function normRu(value) { return String(value || '').trim().toLowerCase().replace(/ё/g, 'е'); }
function capWord(value) { const word=String(value || ''); return word.charAt(0).toUpperCase()+word.slice(1).toLowerCase(); }
const MEDSI_CONTACT_FEMALE_NAMES_ = new Set([
  'агния','авелина','александра','алина','алиса','алла','алёна','алена','анастасия','ангелина','анна','анфиса','аня','арина','асья','ася',
  'валентина','валерия','валя','варвара','варя','василиса','вера','вероника','вика','виктория','галя','галина','дарина','дарья','даша',
  'диана','евгения','ева','екатерина','елена','елизавета','жанна','женя','зариат','зарият','злата','инна','ира','ирина','карина','катя','кира',
  'ксения','ксеня','ксюша','лариса','лена','лера','лида','лидия','лиза','лилия','лия','люба','любовь','люда','людмила','маргарита','марго','марина',
  'мария','маша','мила','милана','милена','мира','мирослава','надежда','надя','настя','наталия','наталья','наташа','оксана','олеся','оля','ольга',
  'поля','полина','рита','рузалия','света','светлана','софия','софья','софа','соня','стефания','стефани','стеша','тая','таисия','тася','таня','татьяна',
  'саша','ульяна','хадижа','хадиджа','юлия','юля','яна','ярослава','яся'
]);
const MEDSI_CONTACT_MALE_NAMES_ = new Set([
  'александр','алексей','алёша','алеша','андрей','анатолий','антон','артем','артём','борис','боря','вадим','валерий','василий','вася',
  'ваня','виталий','витя','виктор','влад','владимир','владислав','володя','вова','всеволод','вячеслав','гамзат','герман','глеб','григорий','гриша',
  'данил','даниил','данила','данилла','даня','денис','дима','дмитрий','егор','евгений','елисей','иван','игорь','илья','иля','кирилл','коля','константин','костя',
  'лев','лева','лёва','леонид','лёня','леня','леша','лёша','лука','макар','макс','максим','марк','матвей','михаил','миша','мирон','никита','николай',
  'олег','павел','паша','роман','рома','руслан','саадула','савелий','саша','сема','семен','семён','сергей','сережа','серёжа','слава','станислав','стас','степа','стёпа','степан',
  'сева','тимофей','тимур','тёма','тема','федор','фёдор','федя','ян','яков','ярик','ярослав'
]);

const MEDSI_CONTACT_GENITIVE_EXCEPTIONS_ = {
  'любовь': 'Любы', 'лев': 'Льва', 'илья': 'Ильи', 'никита': 'Никиты', 'лука': 'Луки', 'фома': 'Фомы',
  'кузьма': 'Кузьмы', 'паша': 'Паши', 'саша': 'Саши', 'женя': 'Жени', 'даня': 'Дани',
  'ваня': 'Вани', 'валя': 'Вали', 'миша': 'Миши', 'костя': 'Кости', 'слава': 'Славы', 'федя': 'Феди', 'ярик': 'Ярика'
};

function medsiContactGender_(nameRaw) {
  const name = normRu(nameRaw).split(/\s+/)[0];
  const female = MEDSI_CONTACT_FEMALE_NAMES_.has(name);
  const male = MEDSI_CONTACT_MALE_NAMES_.has(name);
  if (female && male) return 'ambiguous';
  if (female) return 'female';
  if (male) return 'male';
  return '';
}

function medsiContactFamilyGenderHint_(familyRaw) {
  const family = normRu(familyRaw);
  if (/((ова|ева|ёва|ина|ына|ская|цкая|ая|яя))$/u.test(family)) return 'female';
  if (/((ов|ев|ёв|ин|ын|ский|цкий|ый|ий))$/u.test(family)) return 'male';
  return '';
}

function medsiContactCap_(value) {
  return String(value || '').split(/\s+/).filter(Boolean).map(capWord).join(' ');
}

function medsiContactGenitiveName_(nameRaw, gender) {
  const name = medsiContactCap_(nameRaw);
  const norm = normRu(name);
  if (!name || !gender) return name;
  if (MEDSI_CONTACT_GENITIVE_EXCEPTIONS_[norm]) return MEDSI_CONTACT_GENITIVE_EXCEPTIONS_[norm];
  if (gender === 'female') {
    if (/ия$/u.test(name)) return name.slice(0, -1) + 'и';
    if (/ья$/u.test(name)) return name.slice(0, -1) + 'и';
    if (/я$/u.test(name)) return name.slice(0, -1) + 'и';
    if (/ь$/u.test(name)) return name + 'и';
    if (/а$/u.test(name)) return name.slice(0, -1) + (/[гкхжчшщ]а$/iu.test(name) ? 'и' : 'ы');
    return name;
  }
  if (gender === 'ambiguous') return name;
  if (/й$/u.test(name) || /ь$/u.test(name)) return name.slice(0, -1) + 'я';
  if (/я$/u.test(name)) return name.slice(0, -1) + 'и';
  if (/а$/u.test(name)) return name.slice(0, -1) + 'ы';
  return name + 'а';
}

function medsiContactGenitiveFamily_(familyRaw, gender) {
  const family = medsiContactCap_(familyRaw);
  if (!family || !gender) return family;
  if (gender === 'female') {
    // Меняем именно окончание, а не отрезаем фиксированное число букв:
    // «Жураховская» → «Жураховской», «Устьянцева» → «Устьянцевой».
    if (/цкая$/iu.test(family) || /ская$/iu.test(family)) return family.replace(/ая$/iu, 'ой');
    if (/ова$/iu.test(family) || /ева$/iu.test(family) || /ёва$/iu.test(family) || /ина$/iu.test(family) || /ына$/iu.test(family)) return family.replace(/а$/iu, 'ой');
    if (/ая$/iu.test(family)) return family.replace(/ая$/iu, 'ой');
    if (/яя$/iu.test(family)) return family.replace(/яя$/iu, 'ей');
    return family;
  }
  if (/цкий$/iu.test(family)) return family.slice(0, -2) + 'ого';
  if (/ский$/iu.test(family)) return family.slice(0, -2) + 'ого';
  if (/ов$/iu.test(family) || /ев$/iu.test(family) || /ёв$/iu.test(family) || /ин$/iu.test(family) || /ын$/iu.test(family)) return family + 'а';
  if (/ый$/iu.test(family)) return family.slice(0, -2) + 'ого';
  if (/ий$/iu.test(family)) return family.slice(0, -2) + 'его';
  return family;
}

function defaultParentRelationship_(parentName) {
  const gender = medsiContactGender_(String(parentName || '').trim().split(/\s+/)[0]);
  return gender === 'female' ? 'Мама' : (gender === 'male' ? 'Папа' : 'Родитель');
}

function parentChildGenitive_(childName) {
  const words = String(childName || '').trim().split(/\s+/);
  const first = words.shift();
  let gender = medsiContactGender_(first);
  if (!first || !gender) return '';
  const family = words.join(' ');
  if (gender === 'ambiguous') gender = medsiContactFamilyGenderHint_(family) || 'ambiguous';
  return [medsiContactGenitiveName_(first, gender), medsiContactGenitiveFamily_(family, gender)].filter(Boolean).join(' ');
}

// Only used when an older registration form omitted the child's surname.
// Explicitly entered child surnames are never changed by this helper.
function inheritedChildFamily_(childFirst, parentFamily) {
  const family = String(parentFamily || '').trim();
  const gender = medsiContactGender_(childFirst);
  if (gender === 'male') {
    if (/(?:ова|ева|ёва|ина|ына)$/iu.test(family)) return family.slice(0, -1);
    if (/(?:ская|цкая)$/iu.test(family)) return family.slice(0, -2) + 'ий';
  }
  if (gender === 'female') {
    if (/(?:ов|ев|ёв|ин|ын)$/iu.test(family)) return family + 'а';
    if (/(?:ский|цкий)$/iu.test(family)) return family.slice(0, -2) + 'ая';
  }
  return family;
}



function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,x-medsi-chat-session,x-medsi-phone,x-file-name,x-medsi-upload-id'
    }
  });
}

function phone10(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const parentAuthProfileCache = new Map();
async function getParentAuthProfile(env, phone) {
  const cached = parentAuthProfileCache.get(phone);
  if (cached && cached.until > Date.now()) return cached.value;
  const row = await env.CHAT_DB.prepare(`SELECT generation_id, created_at
    FROM parent_auth_profiles WHERE phone10=?`).bind(phone).first();
  parentAuthProfileCache.delete(phone);
  if (parentAuthProfileCache.size >= 200) parentAuthProfileCache.delete(parentAuthProfileCache.keys().next().value);
  parentAuthProfileCache.set(phone, { value: row || null, until: Date.now() + 15000 });
  return row || null;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorized(request, env) {
  let raw = request.headers.get('x-medsi-chat-session') || '';
  // Read-only browser calls deliberately use a CORS-simple text/plain POST
  // (see chat-adapter.html).  Clone keeps the original body available to any
  // later route handler.
  if (!raw && request.method === 'POST' && /^text\/plain(?:;|$)/i.test(request.headers.get('content-type') || '')) {
    try { raw = String((JSON.parse(await request.clone().text()) || {})._medsiChatSession || ''); } catch (_) {}
  }
  const [payload, signature] = raw.split('.');
  if (!payload || !signature || !env.LAB_D1_SESSION_SECRET) return null;
  if (!equal(await hmac(env.LAB_D1_SESSION_SECRET, payload), signature)) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (Number(claims.exp) <= Date.now()) return null;
    if (claims.role === 'parent' || (!claims.role && phone10(claims.phone10))) {
      const generation = await getParentAuthProfile(env, String(claims.phone10 || ''));
      if (!generation) return null;
      if (claims.authGeneration) {
        if (claims.authGeneration !== generation.generation_id) return null;
      } else {
        // Existing active profiles were seeded with created_at=0 during the
        // auth migration, so their saved sessions keep working. Profiles
        // created or recreated after that point must not inherit a token that
        // has no generation (especially legacy Apps Script tokens without exp).
        const createdAt = Number(generation.created_at || 0);
        if (createdAt > 0) {
          const expiresAt = Number(claims.exp);
          const issuedAt = expiresAt - 30 * 24 * 60 * 60 * 1000;
          if (!Number.isFinite(expiresAt) || expiresAt <= 0 || createdAt > issuedAt) return null;
        }
      }
    }
    return claims;
  } catch { return null; }
}

async function body(request) {
  try { return await request.json(); } catch { return null; }
}

function registrationId(value) {
  const id = String(value || '').trim();
  return /^reg_[A-Za-z0-9_-]{16,115}$/.test(id) ? id : '';
}

function parentDeletionId(value) {
  const id = String(value || '').trim();
  return /^delete_[A-Za-z0-9_-]{12,115}$/.test(id) ? id : '';
}

function parentAccessRequestId(value) {
  const id = String(value || '').trim();
  return /^auth_[A-Za-z0-9_-]{16,115}$/.test(id) ? id : '';
}

function parentAccessSecret(value) {
  const secret = String(value || '').trim();
  return /^[A-Za-z0-9_-]{40,60}$/.test(secret) ? secret : '';
}

async function parentAccessSecretHash(value) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')))));
}

async function issueParentSession(phone, secret, env, expiresAtOverride) {
  // Saved sessions survive ordinary long stays. Profile deletion still revokes
  // them immediately through the profile-generation check.
  const exp = Number(expiresAtOverride) > Date.now()
    ? Number(expiresAtOverride)
    : Date.now() + 365 * 24 * 60 * 60 * 1000;
  parentAuthProfileCache.delete(phone);
  const generation = env ? await getParentAuthProfile(env, phone) : null;
  if (!generation) throw new Error('Active parent profile is required to issue a session.');
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    role: 'parent', phone10: phone, exp, authGeneration: generation.generation_id, version: 'cf-parent-v2'
  })));
  return hmac(secret, payload).then(signature => ({
    token: payload + '.' + signature,
    expiresAt: exp
  }));
}

async function parentHasActivePasskey(env, phone) {
  const account = await env.CHAT_DB.prepare('SELECT user_handle FROM parent_auth_profiles WHERE phone10=?').bind(phone).first();
  if (!account) return false;
  const credential = await env.CHAT_DB.prepare(`SELECT 1 AS present FROM parent_passkeys
    WHERE user_handle=? AND revoked_at IS NULL LIMIT 1`).bind(account.user_handle).first();
  return !!credential;
}

async function markParentReportRead(request, env, auth) {
  if (auth.role !== 'parent') return json({ ok:false, message:'Forbidden' }, 403);
  const payload = await body(request) || {};
  const kind = String(payload.kind || '').toLowerCase();
  const version = String(payload.version || '').slice(0, 180);
  if (!['morning','evening','psychology'].includes(kind) || !version) return json({ ok:false, message:'Некорректный отчёт.' }, 400);
  const result = await env.CHAT_DB.prepare(`UPDATE report_current SET read_version=version
    WHERE phone10=? AND kind=? AND version=? AND read_version IS NOT version`).bind(auth.phone10, kind, version).run();
  return json({ ok:true, skipped:!Number(result.meta && result.meta.changes || 0) });
}

async function getParentReportUnread(env, auth) {
  if (auth.role !== 'parent') return json({ ok:false, message:'Forbidden' }, 403);
  const rows = await env.CHAT_DB.prepare(`SELECT kind, version, read_version FROM report_current WHERE phone10=?`).bind(auth.phone10).all();
  const reportUnread = { morning:false, evening:false, psychology:false };
  for (const row of rows.results || []) reportUnread[row.kind] = !!row.version && row.version !== row.read_version;
  return json({ ok:true, reportUnread });
}

async function getCurrentReportVersions(env) {
  const rows = await env.CHAT_DB.prepare(`SELECT phone10, kind, version, updated_at
    FROM report_current WHERE TRIM(text)<>''`).all();
  return json({ok:true, versions:(rows.results||[]).map(row=>({
    phone:row.phone10, kind:row.kind, version:row.version||'', updatedAt:Number(row.updated_at||0)
  }))});
}

async function getReportInactivityReminder(env) {
  const rows = await env.CHAT_DB.prepare(`SELECT s.phone10, s.last_new_report_at, s.first_seen_at, s.last_prompt_days, s.roster_order, p.child_name
    FROM report_inactivity_state s JOIN chat_profiles p ON p.phone10=s.phone10
    ORDER BY s.roster_order DESC, s.phone10 DESC`).all();
  const now = Date.now();
  for (const row of rows.results || []) {
    const base = Number(row.last_new_report_at || row.first_seen_at || 0);
    const days = Math.floor((now - base) / 86400000);
    const tier = days >= 21 ? 21 : days >= 7 ? 7 : days >= 3 ? 3 : 0;
    if (tier && tier > Number(row.last_prompt_days || 0)) return json({ ok:true, reminder:{ phone:'8'+row.phone10, childName:row.child_name || 'Без имени ребёнка', days, tier, lastNewReportAt:Number(row.last_new_report_at||0), firstSeenAt:Number(row.first_seen_at||0) } });
  }
  return json({ ok:true, reminder:null });
}

async function acknowledgeReportInactivity(request, env) {
  const payload = await body(request) || {}, phone = phone10(payload.phone), tier = Number(payload.tier);
  const expectedLastNewReportAt = Number(payload.expectedLastNewReportAt || 0);
  const expectedFirstSeenAt = Number(payload.expectedFirstSeenAt || 0);
  if (!phone || ![3,7,21].includes(tier) || !expectedFirstSeenAt) return json({ ok:false, message:'Некорректное напоминание.' }, 400);
  const result = await env.CHAT_DB.prepare(`UPDATE report_inactivity_state SET last_prompt_days=?
    WHERE phone10=? AND last_new_report_at=? AND first_seen_at=? AND last_prompt_days<?`).bind(tier, phone, expectedLastNewReportAt, expectedFirstSeenAt, tier).run();
  return Number(result.meta && result.meta.changes || 0) ? json({ ok:true }) : json({ ok:false, message:'Напоминание уже не найдено.' }, 404);
}

async function syncReportInactivity(request, env) {
  const payload = await body(request) || {}, items = Array.isArray(payload.items) ? payload.items.slice(0, 500) : [];
  const now = Date.now(), statements=[];
  items.forEach((item, index) => {
    const phone=phone10(item && item.phone); if(!phone)return;
    const eventAt=Number(item && item.lastNewReportAt || (item && item.hasNewReport ? now : 0)), first=Number(item && item.firstSeenAt || now), tier=Number(item && item.lastPromptDays || 0);
    statements.push(env.CHAT_DB.prepare(`INSERT INTO report_inactivity_state(phone10,last_new_report_at,first_seen_at,last_prompt_days,roster_order)
      VALUES(?,?,?,?,?) ON CONFLICT(phone10) DO UPDATE SET
      last_new_report_at=CASE WHEN excluded.last_new_report_at>report_inactivity_state.last_new_report_at THEN excluded.last_new_report_at ELSE report_inactivity_state.last_new_report_at END,
      first_seen_at=CASE WHEN report_inactivity_state.first_seen_at=0 THEN excluded.first_seen_at ELSE report_inactivity_state.first_seen_at END,
      last_prompt_days=CASE WHEN excluded.last_new_report_at>report_inactivity_state.last_new_report_at THEN 0
        ELSE report_inactivity_state.last_prompt_days END,
      roster_order=excluded.roster_order
      WHERE excluded.last_new_report_at>report_inactivity_state.last_new_report_at
        OR (report_inactivity_state.first_seen_at=0 AND excluded.first_seen_at<>0)
      OR excluded.roster_order<>report_inactivity_state.roster_order`).bind(phone, eventAt, first, tier, Number(item && item.rosterOrder || index)));
  });
  if(statements.length) await env.CHAT_DB.batch(statements);
  return json({ok:true,received:statements.length});
}

async function removeReportInactivity(request, env) {
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  if (!phone) return json({ok:false,message:'Некорректный номер профиля.'},400);
  const result = await env.CHAT_DB.prepare('DELETE FROM report_inactivity_state WHERE phone10=?').bind(phone).run();
  return json({ok:true,deleted:Number(result.meta && result.meta.changes || 0) > 0});
}

async function registerParent(request, env) {
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  const parentName = String(payload.parentName || '').trim().slice(0, 160);
  const rawChildName = String(payload.childName || '').trim().slice(0, 160);
  const childWords = rawChildName.split(/\s+/);
  const inheritedFamily = childWords.length === 1 ? inheritedChildFamily_(childWords[0], parentName.split(/\s+/).slice(1).join(' ')) : '';
  const childName = inheritedFamily ? rawChildName + ' ' + inheritedFamily : rawChildName;
  const attemptId = registrationId(payload.attemptId);
  if (!phone || !parentName || !childName || !attemptId) {
    return json({ ok: false, message: 'Заполните имя родителя, имя ребёнка и корректный телефон.' }, 400);
  }
  if (!env.LAB_D1_SESSION_SECRET) return json({ ok: false, message: 'Сервис регистрации временно недоступен.' }, 503);

  const pendingDeletion = await env.CHAT_DB.prepare(`
    SELECT operation_id
    FROM parent_deletion_queue
    WHERE phone10 = ? AND status IN ('pending','retry','processing','failed')
    LIMIT 1
  `).bind(phone).first();
  if (pendingDeletion) {
    return json({
      ok:false,
      code:'DELETION_PENDING',
      message:'Предыдущее удаление этого профиля ещё завершается. Попробуйте зарегистрироваться чуть позже.'
    }, 409);
  }

  const priorAttempt = await env.CHAT_DB.prepare(
    'SELECT phone10, parent_name, child_name FROM parent_registration_attempts WHERE attempt_id = ?'
  ).bind(attemptId).first();
  if (priorAttempt) {
    if (priorAttempt.phone10 !== phone || priorAttempt.parent_name !== parentName || (priorAttempt.child_name !== childName && priorAttempt.child_name !== rawChildName)) {
      return json({ ok: false, message: 'Эта попытка регистрации относится к другим данным. Вернитесь назад и повторите ввод.' }, 409);
    }
    const active = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
    if (!active) return json({ ok: false, status: 'REVOKED', message: 'Регистрация уже удалена. Начните заново.' }, 410);
    await env.CHAT_DB.prepare(`UPDATE chat_profiles SET profile_generation = ?
      WHERE phone10 = ? AND profile_generation = ''`).bind(attemptId, phone).run();
    const session = await issueParentSession(phone, env.LAB_D1_SESSION_SECRET, env);
    return json({ ok: true, duplicate: false, phone: '8' + phone, parentName, childName,
      parentSession: session.token, d1Session: { ok: true, ...session }, registrationAttemptId: attemptId });
  }

  const existing = await env.CHAT_DB.prepare(
    'SELECT phone10 FROM chat_profiles WHERE phone10 = ?'
  ).bind(phone).first();
  if (existing) return json({ ok: true, duplicate: true });

  const createdAt = Date.now();
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare(`INSERT INTO parent_registration_attempts
      (attempt_id, phone10, parent_name, child_name, status, created_at) VALUES (?, ?, ?, ?, 'COMPLETED', ?)
      ON CONFLICT(attempt_id) DO NOTHING`).bind(attemptId, phone, parentName, childName, createdAt),
    env.CHAT_DB.prepare(`INSERT INTO chat_profiles
      (phone10, parent_name, child_name, relationship, child_genitive, profile_generation)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(phone10) DO NOTHING`).bind(
        phone, parentName, childName, defaultParentRelationship_(parentName), parentChildGenitive_(childName), attemptId),
    env.CHAT_DB.prepare(`INSERT INTO parent_registration_outbox (attempt_id, phone10, parent_name, child_name, created_at)
      SELECT ?, phone10, parent_name, child_name, ? FROM chat_profiles
      WHERE phone10 = ? AND parent_name = ? AND child_name = ?
      ON CONFLICT(attempt_id) DO NOTHING`).bind(attemptId, createdAt, phone, parentName, childName)
  ]);

  const saved = await env.CHAT_DB.prepare(
    'SELECT phone10, parent_name, child_name FROM parent_registration_attempts WHERE attempt_id = ?'
  ).bind(attemptId).first();
  const savedProfile = await env.CHAT_DB.prepare(
    'SELECT phone10, parent_name, child_name, relationship, child_genitive FROM chat_profiles WHERE phone10 = ?'
  ).bind(phone).first();
  if (!saved || saved.phone10 !== phone || saved.parent_name !== parentName || saved.child_name !== childName ||
      !savedProfile || savedProfile.parent_name !== parentName || savedProfile.child_name !== childName) {
    if (saved) await env.CHAT_DB.prepare('DELETE FROM parent_registration_attempts WHERE attempt_id = ?').bind(attemptId).run();
    if (savedProfile) return json({ ok: true, duplicate: true });
    return json({ ok: false, message: 'Не удалось сохранить регистрацию. Попробуйте ещё раз.' }, 503);
  }

  const session = await issueParentSession(phone, env.LAB_D1_SESSION_SECRET, env);
  return json({ ok: true, duplicate: false, phone: '8' + phone, parentName, childName,
    parentSession: session.token, d1Session: { ok: true, ...session }, registrationAttemptId: attemptId });
}

async function getParentRegistrationStatus(request, env) {
  const url = new URL(request.url);
  const phone = phone10(url.searchParams.get('phone'));
  const attemptId = registrationId(url.searchParams.get('attemptId'));
  if (!phone || !attemptId) return json({ ok: true, status: 'NOT_FOUND' });
  if (!env.LAB_D1_SESSION_SECRET) return json({ ok: false, message: 'Сервис регистрации временно недоступен.' }, 503);
  const attempt = await env.CHAT_DB.prepare(
    'SELECT phone10, parent_name, child_name FROM parent_registration_attempts WHERE attempt_id = ?'
  ).bind(attemptId).first();
  if (!attempt || attempt.phone10 !== phone) return json({ ok: true, status: 'NOT_FOUND' });
  const active = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!active) return json({ ok: true, status: 'REVOKED' });
  const session = await issueParentSession(phone, env.LAB_D1_SESSION_SECRET, env);
  return json({ ok: true, status: 'COMPLETED', phone: '8' + phone,
    parentName: attempt.parent_name, childName: attempt.child_name,
    parentSession: session.token, d1Session: { ok: true, ...session }, registrationAttemptId: attemptId });
}

async function listParentRegistrationOutbox(env) {
  const rows = await env.CHAT_DB.prepare(`SELECT o.attempt_id, o.phone10, o.parent_name, o.child_name, o.created_at
    FROM parent_registration_outbox o
    JOIN chat_profiles p ON p.phone10 = o.phone10 AND p.profile_generation = o.attempt_id
    ORDER BY o.created_at ASC LIMIT 50`).all();
  return json({ ok: true, registrations: rows.results || [] });
}

async function acknowledgeParentRegistrationOutbox(request, env) {
  const payload = await body(request) || {};
  const ids = Array.isArray(payload.attemptIds) ? payload.attemptIds.map(registrationId).filter(Boolean).slice(0, 50) : [];
  if (!ids.length) return json({ ok: true, acknowledged: 0, acceptedAttemptIds:[], revokedAttemptIds:[] });
  const acceptedAttemptIds = [], revokedAttemptIds = [];
  for (const id of ids) {
    const acknowledged = await env.CHAT_DB.prepare(`DELETE FROM parent_registration_outbox
      WHERE attempt_id = ? AND EXISTS (
        SELECT 1 FROM chat_profiles p
        WHERE p.phone10 = parent_registration_outbox.phone10 AND p.profile_generation = ?
      )`).bind(id, id).run();
    if (acknowledged.meta && acknowledged.meta.changes) {
      acceptedAttemptIds.push(id);
      continue;
    }
    const alreadyApplied = await env.CHAT_DB.prepare(
      'SELECT phone10 FROM chat_profiles WHERE profile_generation = ?'
    ).bind(id).first();
    (alreadyApplied ? acceptedAttemptIds : revokedAttemptIds).push(id);
  }
  return json({ ok:true, acknowledged:acceptedAttemptIds.length, acceptedAttemptIds, revokedAttemptIds });
}

async function failParentRegistrationOutbox(request, env) {
  const payload = await body(request) || {};
  const id = registrationId(payload.attemptId);
  if (!id) return json({ ok: false, message: 'Invalid attempt ID.' }, 400);
  await env.CHAT_DB.prepare(`UPDATE parent_registration_outbox SET attempts = attempts + 1, last_error = ?
    WHERE attempt_id = ?`).bind(String(payload.message || 'Sync failed').slice(0, 500), id).run();
  return json({ ok: true });
}

async function requestParentAccess(request, env) {
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  if (!phone) return json({ ok:false, message:'Проверьте номер телефона.' }, 400);
  const profile = await env.CHAT_DB.prepare('SELECT phone10, parent_name, child_name, relationship, child_genitive FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!profile) return json({ ok: false, code: 'NOT_FOUND', message: 'Этот номер не найден среди активных родителей.' }, 404);

  // Parents who declined a passkey can recover a lost browser session with
  // their phone number. Passkey users must use that key; educator approval is
  // no longer part of the login path.
  if (await parentHasActivePasskey(env, phone)) {
    return json({ ok:false, code:'PASSKEY_REQUIRED', message:'Для этого аккаунта включён вход с ключом доступа. Войдите с помощью ключа.' }, 409);
  }
  {
    if (!env.LAB_D1_SESSION_SECRET) return json({ ok:false, message:'Сервис авторизации временно недоступен.' }, 503);
    const session = await issueParentSession(phone, env.LAB_D1_SESSION_SECRET, env);
    return json({ ok:true, status:'APPROVED', recoveryMode:'phone-only', phone:'8' + phone,
      parentName:profile.parent_name || '', childName:profile.child_name || '',
      parentSession:session.token, d1Session:{ ok:true, ...session } });
  }
}

async function getParentAccessStatus(request, env) {
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  const requestId = parentAccessRequestId(payload.requestId);
  const requestSecret = parentAccessSecret(payload.requestSecret);
  const secretHash = requestSecret ? await parentAccessSecretHash(requestSecret) : '';
  if (!secretHash) return json({ ok: true, status: 'NOT_FOUND' });
  if (!phone || !requestId) return json({ ok: true, status: 'NOT_FOUND' });
  const profile = await env.CHAT_DB.prepare('SELECT phone10, parent_name, child_name, relationship, child_genitive FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!profile) return json({ ok: true, status: 'NOT_FOUND' });
  const row = await env.CHAT_DB.prepare('SELECT * FROM parent_access_requests WHERE request_id = ?').bind(requestId).first();
  if (!row || row.phone10 !== phone) return json({ ok: true, status: 'NOT_FOUND' });
  if (!equal(String(row.request_secret_hash || ''), secretHash)) return json({ ok: true, status: 'NOT_FOUND' });
  let status = String(row.status || '').toUpperCase();
  const now = Date.now();
  const expired = Number(row.expires_at) <= now;
  if ((status === 'PENDING' || status === 'APPROVED') && expired) {
    await env.CHAT_DB.prepare("UPDATE parent_access_requests SET status='EXPIRED', updated_at=? WHERE request_id=? AND status IN ('PENDING','APPROVED')").bind(now, requestId).run();
    status = 'EXPIRED';
  }
  if (status === 'PENDING') {
    if (await parentHasActivePasskey(env, phone)) {
      await env.CHAT_DB.prepare(`UPDATE parent_access_requests SET status='DENIED', decision='PASSKEY_REQUIRED', updated_at=?
        WHERE request_id=? AND status='PENDING'`).bind(now, requestId).run();
      return json({ ok:true, requestId, phone:'8' + phone, status:'PASSKEY_REQUIRED' });
    }
    const consumed = await env.CHAT_DB.prepare(`UPDATE parent_access_requests SET status='CONSUMED', decision='PHONE_ONLY', updated_at=?
      WHERE request_id=? AND status='PENDING' AND expires_at>? AND request_secret_hash=?`)
      .bind(now, requestId, now, secretHash).run();
    if (Number(consumed.meta && consumed.meta.changes || 0) === 1) {
      status = 'CONSUMED';
      row.updated_at = now;
    } else {
      const current = await env.CHAT_DB.prepare('SELECT status, updated_at, decision FROM parent_access_requests WHERE request_id=? AND phone10=? AND request_secret_hash=?')
        .bind(requestId, phone, secretHash).first();
      status = String(current && current.status || 'NOT_FOUND').toUpperCase();
      row.updated_at = current && current.updated_at || row.updated_at;
      row.decision = current && current.decision || '';
    }
  }
  if (status === 'DENIED' && row.decision === 'PASSKEY_REQUIRED') {
    return json({ ok:true, requestId, phone:'8' + phone, status:'PASSKEY_REQUIRED' });
  }
  if (status === 'APPROVED' || status === 'CONSUMED') {
    if (!env.LAB_D1_SESSION_SECRET) return json({ ok: false, message: 'Сервис авторизации временно недоступен.' }, 503);
    // Allow the same device to recover a lost HTTP response for 24 hours.
    // A deterministic expiry makes the re-issued signed session identical.
    if (status === 'CONSUMED' && now > Number(row.updated_at || 0) + 24 * 60 * 60 * 1000) {
      return json({ ok:true, requestId, phone:'8' + phone, status:'EXPIRED' });
    }
    if (status === 'APPROVED') {
      const consumed = await env.CHAT_DB.prepare(`UPDATE parent_access_requests SET status='CONSUMED', updated_at=?
        WHERE request_id=? AND status='APPROVED' AND expires_at>? AND request_secret_hash=?`)
        .bind(now, requestId, now, secretHash).run();
      if (Number(consumed.meta && consumed.meta.changes || 0) !== 1) {
        const current = await env.CHAT_DB.prepare('SELECT status, updated_at FROM parent_access_requests WHERE request_id=? AND phone10=? AND request_secret_hash=?')
          .bind(requestId, phone, secretHash).first();
        if (!current || current.status !== 'CONSUMED' || now > Number(current.updated_at || 0) + 24 * 60 * 60 * 1000) {
          return json({ ok:true, requestId, phone:'8' + phone, status:current && current.status || 'NOT_FOUND' });
        }
        row.updated_at = current.updated_at;
      } else {
        row.updated_at = now;
      }
    }
    const stableExpiry = Number(row.expires_at) + 365 * 24 * 60 * 60 * 1000;
    const session = await issueParentSession(phone, env.LAB_D1_SESSION_SECRET, env, stableExpiry);
    return json({ ok: true, status: 'APPROVED', requestId, phone: '8' + phone,
      parentName: profile.parent_name || '', childName: profile.child_name || '',
      parentSession: session.token, d1Session: { ok: true, ...session } });
  }
  return json({ ok: true, requestId, phone: '8' + phone, code: row.code, status,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    expiresAt: new Date(Number(row.expires_at)).toISOString() });
}

async function listParentAccessRequests(env) {
  const now = Date.now();
  await env.CHAT_DB.prepare("UPDATE parent_access_requests SET status='EXPIRED', updated_at=? WHERE status='PENDING' AND expires_at<=?").bind(now, now).run();
  return json({ ok:true, requests:[] });
}

async function decideParentAccessRequest(request, env) {
  return json({ ok:false, code:'PARENT_APPROVAL_DISABLED', message:'Подтверждение входа воспитателем отключено.' }, 410);
}

function assertPhone(raw, env) {
  const phone = phone10(raw);
  if (!phone) throw new Error('A valid phone is required.');
  return phone;
}

function messageFromRow(row) {
  const fileId = row.file_id || '';
  return {
    messageKey: row.message_key,
    phone: row.phone10,
    side: row.side,
    type: row.type,
    text: row.text,
    timestamp: row.created_at,
    readByParent: Boolean(row.read_by_parent),
    readByEducator: Boolean(row.read_by_educator),
    fileId,
    mediaUrl: fileId.startsWith('kv:') ? '/media/' + encodeURIComponent(fileId.slice(3)) : '',
    reaction: row.reaction || '',
    reply: row.reply_to_key ? { messageKey: row.reply_to_key } : null,
    status: row.status || 'active'
  };
}

function mediaType(value) {
  const type = String(value || '').toLowerCase().split(';')[0].trim();
  return new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif',
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/x-msvideo'
  ]).has(type) ? type : '';
}

function mediaName(value) {
  return String(value || 'attachment').replace(/[^\w. -]/g, '_').slice(0, 160) || 'attachment';
}


async function authorizeFormSession_(raw, env) {
  const value = String(raw || '');
  const [payload, signature] = value.split('.');

  if (!payload || !signature || !env.LAB_D1_SESSION_SECRET) return null;
  if (!equal(await hmac(env.LAB_D1_SESSION_SECRET, payload), signature)) return null;

  try {
    const claims = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    );
    return Number(claims.exp) > Date.now() ? claims : null;
  } catch (_) {
    return null;
  }
}

async function uploadMediaForm(request, env) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  const maxBytes = 20 * 1024 * 1024;

  if (contentLength > maxBytes + 1024 * 1024) {
    return json({ ok: false, message: 'Размер файла не должен превышать 20 МБ.' }, 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return json({ ok: false, message: 'Некорректные данные загрузки.' }, 400);
  }

  const auth = await authorizeFormSession_(
    form.get('_medsiChatSession'),
    env
  );

  if (!auth) {
    return json({ ok: false, message: 'Unauthorized' }, 401);
  }

  if (!['parent', 'educator'].includes(auth.role)) {
    return json({ ok: false, message: 'Forbidden' }, 403);
  }

  const phone = assertPhone(String(form.get('phone') || ''), env);

  if (auth.role === 'parent' && phone !== auth.phone10) {
    return json({ ok: false, message: 'Forbidden' }, 403);
  }
  const profile = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!profile) return json({ ok:false, code:'CHAT_CLOSED', message:'Chat is closed' }, 410);

  const file = form.get('file');

  if (!file || typeof file.arrayBuffer !== 'function') {
    return json({ ok: false, message: 'Файл не получен.' }, 400);
  }

  const mimeType = mediaType(file.type || '');

  if (!mimeType) {
    return json({ ok: false, message: 'Можно прикреплять только фото или видео.' }, 400);
  }

  const data = await file.arrayBuffer();

  if (data.byteLength > maxBytes) {
    return json({ ok: false, message: 'Размер файла не должен превышать 20 МБ.' }, 413);
  }

  const key = `media:${crypto.randomUUID()}`;

  await env.CHAT_MEDIA.put(key, data, {
    metadata: {
      contentType: mimeType,
      name: mediaName(file.name || 'attachment')
    }
  });

  return json({
    ok: true,
    fileId: 'kv:' + key,
    url: '/media/' + encodeURIComponent(key),
    type: mimeType.startsWith('video/') ? 'video' : 'image'
  });
}

async function uploadMedia(request, env, auth) {
  const mimeType = mediaType(request.headers.get('content-type'));
  if (!mimeType) return json({ ok: false, message: 'Можно прикреплять только фото или видео.' }, 400);
  const bytes = Number(request.headers.get('content-length') || 0);
  const maxBytes = 20 * 1024 * 1024;
  if (bytes > maxBytes) return json({ ok: false, message: 'Размер файла не должен превышать 20 МБ.' }, 413);
  const rawPhone = request.headers.get('x-medsi-phone') || '';
  const phone = assertPhone(rawPhone, env);
  if (auth.role === 'parent' && phone !== auth.phone10) return json({ ok: false, message: 'Forbidden' }, 403);
  if (!['parent', 'educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
  const profile = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!profile) return json({ ok:false, code:'CHAT_CLOSED', message:'Chat is closed' }, 410);
  const data = await request.arrayBuffer();
  if (data.byteLength > maxBytes) return json({ ok: false, message: 'Размер файла не должен превышать 20 МБ.' }, 413);
  const rawUploadId = String(request.headers.get('x-medsi-upload-id') || '').trim();
  const uploadId = /^[a-zA-Z0-9_-]{8,120}$/.test(rawUploadId) ? rawUploadId : '';
  const key = `media:${uploadId || crypto.randomUUID()}`;

  await env.CHAT_MEDIA.put(key, data, {
    metadata: { contentType: mimeType, name: mediaName(request.headers.get('x-file-name')) }
  });
  return json({ ok: true, fileId: 'kv:' + key, url: '/media/' + encodeURIComponent(key), type: mimeType.startsWith('video/') ? 'video' : 'image' });
}

async function serveMedia(env, key) {
  if (!key || key.includes('..')) return new Response('Not found', { status: 404 });
  const object = await env.CHAT_MEDIA.getWithMetadata(key, 'arrayBuffer');
  if (!object || !object.value) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  headers.set('content-type', String(object.metadata && object.metadata.contentType || 'application/octet-stream'));
  headers.set('content-disposition', 'inline; filename="' + mediaName(object.metadata && object.metadata.name) + '"');
  headers.set('cache-control', 'private, max-age=3600');
  headers.set('x-content-type-options', 'nosniff');
  return new Response(object.value, { headers });
}

async function requireAdmin(request, env) {
  return Boolean(env.CHAT_ADMIN_TOKEN) && request.headers.get('authorization') === `Bearer ${env.CHAT_ADMIN_TOKEN}`;
}

async function importBatch(request, env) {
  const payload = await body(request) || {};
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.slice(0, 200) : [];
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(0, 400) : [];
  const pins = Array.isArray(payload.pins) ? payload.pins.slice(0, 200) : [];
  const statements = [];

  profiles.forEach(item => {
    const phone = phone10(item && item.phone);
    if (!phone) return;
    statements.push(env.CHAT_DB.prepare(`
      INSERT INTO chat_profiles (phone10, parent_name, child_name) VALUES (?, ?, ?)
      ON CONFLICT(phone10) DO UPDATE SET parent_name = excluded.parent_name, child_name = excluded.child_name
    `).bind(phone, String(item.parentName || '').slice(0, 300), String(item.childName || '').slice(0, 300)));
  });

  messages.forEach(item => {
    const phone = phone10(item && item.phone);
    const key = String(item && item.messageKey || '').trim().slice(0, 300);
    const side = String(item && item.side || '').trim();
    if (!phone || !key || !['parent', 'educator'].includes(side)) return;
    statements.push(env.CHAT_DB.prepare(`
      INSERT INTO chat_messages
        (message_key, phone10, side, type, text, file_id, delete_after, status, reply_to_key, reaction, edited_at, created_at, read_by_parent, read_by_educator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_key) DO UPDATE SET
        phone10=excluded.phone10, side=excluded.side, type=excluded.type, text=excluded.text,
        -- Sheets retains its historical Google Drive ID.  Once a message has
        -- been verified in Timeweb S3, a later idempotent history import must
        -- never replace that durable S3 reference with the legacy source ID.
        file_id=CASE
          WHEN chat_messages.file_id LIKE 's3:%' AND excluded.file_id NOT LIKE 's3:%'
          THEN chat_messages.file_id
          ELSE excluded.file_id
        END,
        delete_after=excluded.delete_after, status=excluded.status,
        reply_to_key=excluded.reply_to_key, reaction=excluded.reaction, edited_at=excluded.edited_at,
        created_at=excluded.created_at, read_by_parent=excluded.read_by_parent, read_by_educator=excluded.read_by_educator
    `).bind(
      key, phone, side, ['text', 'image', 'video'].includes(String(item.type)) ? String(item.type) : 'text',
      String(item.text || '').slice(0, 4000), String(item.fileId || '').slice(0, 200), Number(item.deleteAfter || 0) || null,
      String(item.status || 'active') === 'deleted' ? 'deleted' : 'active', String(item.replyToKey || '').slice(0, 300),
      String(item.reaction || '').slice(0, 16), Number(item.editedAt || 0) || null, Number(item.createdAt || 0) || Date.now(),
      item.readByParent ? 1 : 0, item.readByEducator ? 1 : 0
    ));
  });

  pins.forEach(item => {
    const phone = phone10(item && item.phone);
    const bucket = String(item && item.bucket || '');
    if (!phone || !['read', 'unread'].includes(bucket)) return;
    statements.push(env.CHAT_DB.prepare(`
      INSERT INTO chat_pins (phone10, bucket, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(phone10) DO UPDATE SET bucket=excluded.bucket, updated_at=excluded.updated_at
    `).bind(phone, bucket, Number(item.updatedAt || 0) || Date.now()));
  });
  if (statements.length) await env.CHAT_DB.batch(statements);
  return json({ ok: true, imported: { profiles: profiles.length, messages: messages.length, pins: pins.length } });
}


async function exportChatMessages(request, env) {
  const url = new URL(request.url);
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 400) || 400));

  const totalRow = await env.CHAT_DB.prepare(
    'SELECT COUNT(*) AS total FROM chat_messages'
  ).first();

  const rows = await env.CHAT_DB.prepare(`
    SELECT
      m.message_key,
      m.phone10,
      m.side,
      m.type,
      m.text,
      m.file_id,
      m.delete_after,
      m.status,
      m.reply_to_key,
      m.reaction,
      m.edited_at,
      m.created_at,
      m.read_by_parent,
      m.read_by_educator,
      COALESCE(p.parent_name, '') AS parent_name,
      COALESCE(p.child_name, '') AS child_name
    FROM chat_messages m
    LEFT JOIN chat_profiles p ON p.phone10 = m.phone10
    ORDER BY m.created_at ASC, m.message_key ASC
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();

  return json({
    ok: true,
    total: Number(totalRow && totalRow.total || 0),
    offset,
    limit,
    messages: rows.results || []
  });
}

async function verifySnapshot(env) {
  const totals = await env.CHAT_DB.prepare(`
    SELECT COUNT(*) AS messages, COUNT(DISTINCT phone10) AS phones, COALESCE(MIN(created_at), 0) AS oldest, COALESCE(MAX(created_at), 0) AS newest
    FROM chat_messages
  `).first();
  const byPhone = await env.CHAT_DB.prepare(`
    SELECT phone10, COUNT(*) AS messages, COALESCE(MIN(created_at), 0) AS oldest, COALESCE(MAX(created_at), 0) AS newest
    FROM chat_messages GROUP BY phone10 ORDER BY phone10
  `).all();
  return json({ ok: true, totals, byPhone: byPhone.results });
}

async function upsertReportSnapshots(request, env) {
  const payload = await body(request) || {};
  const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots.slice(0, 500) : [];
  const candidates = [];
  const seen = new Set();

  snapshots.forEach(item => {
    const phone = phone10(item && item.phone);
    const kind = String(item && item.kind || '').trim().toLowerCase();
    const reportDate = String(item && item.reportDate || '').trim();
    const text = String(item && item.text || '').trim();
    const revision = Number(item && item.revision || 0);
    const publicationId = String(item && item.publicationId || '').trim();
    const childAdmissionId = String(item && item.childAdmissionId || '').trim();
    if (!phone || !['morning', 'evening', 'psychology'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !text ||
        !Number.isSafeInteger(revision) || revision < 1 || !/^[A-Za-z0-9_-]{8,180}$/.test(publicationId) ||
        !/^[A-Za-z0-9_-]{8,120}$/.test(childAdmissionId)) return;

    const key = `${phone}|${kind}|${reportDate}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      phone,
      kind,
      reportDate,
      text: text.slice(0, 30000), revision, publicationId, profileGeneration:'', childAdmissionId,
      capturedAt: Number(item.capturedAt || 0) || Date.now()
    });
  });

  const normalizeText = value => String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  let saved = 0;
  let updated = 0;
  let skippedDuplicate = 0;
  let skippedExisting = 0;

  for (const candidate of candidates) {
    const existing = await env.CHAT_DB.prepare(`
      SELECT text, revision, publication_id, profile_generation, child_admission_id
      FROM report_snapshots
      WHERE phone10 = ? AND kind = ? AND report_date = ?
      LIMIT 1
    `).bind(candidate.phone, candidate.kind, candidate.reportDate).first();

    if (existing) {
      if (Number(existing.revision||0) >= candidate.revision) {
        skippedDuplicate++;
        continue;
      }

      const result = await env.CHAT_DB.prepare(`
        UPDATE report_snapshots
        SET text=?, captured_at=?, profile_generation=?, child_admission_id=?, publication_id=?, revision=?
        WHERE phone10=? AND kind=? AND report_date=? AND revision < ?
          AND EXISTS (SELECT 1 FROM report_current c JOIN chat_profiles p ON p.phone10=c.phone10
            WHERE c.phone10=? AND c.kind=? AND c.text=? AND c.revision=? AND c.publication_id=?
              AND c.child_admission_id=? AND p.child_admission_id=c.child_admission_id)
      `).bind(
        candidate.text,
        candidate.capturedAt,
        candidate.profileGeneration,
        candidate.childAdmissionId,
        candidate.publicationId,
        candidate.revision,
        candidate.phone,
        candidate.kind,
        candidate.reportDate,
        candidate.revision,
        candidate.phone,
        candidate.kind,
        candidate.text,
        candidate.revision,
        candidate.publicationId,
        candidate.childAdmissionId
      ).run();

      updated += Number(result && result.meta && result.meta.changes || 0);
      continue;
    }

    if (payload.skipIfMatchesPrevious === true) {
      const previous = await env.CHAT_DB.prepare(`
        SELECT text
        FROM report_snapshots
        WHERE phone10 = ? AND kind = ? AND report_date < ?
        ORDER BY report_date DESC, captured_at DESC
        LIMIT 1
      `).bind(candidate.phone, candidate.kind, candidate.reportDate).first();

      if (previous && normalizeText(previous.text) === normalizeText(candidate.text)) {
        skippedDuplicate++;
        continue;
      }
    }

    const result = await env.CHAT_DB.prepare(`
      INSERT INTO report_snapshots
        (phone10,kind,report_date,text,captured_at,profile_generation,child_admission_id,publication_id,revision)
      SELECT ?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM report_current c JOIN chat_profiles p ON p.phone10=c.phone10
        WHERE c.phone10=? AND c.kind=? AND c.text=? AND c.revision=? AND c.publication_id=?
          AND c.child_admission_id=? AND p.child_admission_id=c.child_admission_id)
      ON CONFLICT(phone10,kind,report_date) DO NOTHING
    `).bind(candidate.phone,candidate.kind,candidate.reportDate,candidate.text,candidate.capturedAt,
      candidate.profileGeneration,candidate.childAdmissionId,candidate.publicationId,candidate.revision,
      candidate.phone,candidate.kind,candidate.text,candidate.revision,candidate.publicationId,
      candidate.childAdmissionId).run();

    const changes = Number(result && result.meta && result.meta.changes || 0);
    if (changes) saved += changes;
    else skippedExisting++;
  }

  const beforeDate = String(payload.beforeDate || '').trim();
  let pruned = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    const result = await env.CHAT_DB.prepare('DELETE FROM report_snapshots WHERE report_date < ?').bind(beforeDate).run();
    pruned = Number(result && result.meta && result.meta.changes || 0);
  }

  return json({
    ok: true,
    received: candidates.length,
    saved,
    updated,
    skippedDuplicate,
    skippedExisting,
    pruned
  });
}

async function getParentReportHistory(env, auth) {
  if (auth.role !== 'parent' || !auth.phone10) return json({ ok: false, message: 'Forbidden' }, 403);
  const result = await env.CHAT_DB.prepare(`
    SELECT kind, report_date, text, captured_at
    FROM report_snapshots
    WHERE phone10 = ?
    ORDER BY report_date DESC, CASE kind WHEN 'morning' THEN 0 WHEN 'psychology' THEN 1 ELSE 2 END
    LIMIT 180
  `).bind(auth.phone10).all();
  return json({
    ok: true,
    reports: (result.results || []).map(row => ({
      kind: row.kind,
      reportDate: row.report_date,
      text: row.text,
      capturedAt: Number(row.captured_at || 0)
    }))
  });
}

async function getCurrentReportPublicationState(env) {
  const result = await env.CHAT_DB.prepare(`SELECT kind, revision, source_fingerprint, publication_id
    FROM report_publication_state`).all();
  const states = {};
  (result.results || []).forEach(row => {
    states[row.kind] = { revision:Number(row.revision || 0), sourceFingerprint:row.source_fingerprint || '', publicationId:row.publication_id || '' };
  });
  return json({ ok:true, states });
}

async function upsertCurrentReports(request, env, ctx) {
  const payload = await body(request) || {};
  const reports = Array.isArray(payload.reports) ? payload.reports.slice(0, 500) : [];
  const publications = payload.publications && typeof payload.publications === 'object' ? payload.publications : {};
  const validKinds = ['morning','evening','psychology'];
  const publicationKinds = validKinds.filter(kind => publications[kind]);
  if (!publicationKinds.length || publicationKinds.some(kind => {
    const item = publications[kind] || {};
    return !Number.isSafeInteger(Number(item.expectedRevision)) || Number(item.expectedRevision) < 0 ||
      !/^[A-Za-z0-9_-]{8,180}$/.test(String(item.publicationId || '')) ||
      !/^[A-Za-z0-9_-]{8,180}$/.test(String(item.sourceFingerprint || ''));
  })) return json({ ok:false, code:'INVALID_REPORT_PUBLICATION', message:'Expected a revision-fenced publication for each report kind.' }, 400);

  const repair = payload.repair === true;
  // Gate every write on the complete admission manifest. A rejected batch must
  // not leave some rows ahead of the shared publication revision.
  const manifests = Object.fromEntries(publicationKinds.map(kind => [kind,[]]));
  reports.forEach(item => {
    const kind=String(item && item.kind || '').trim().toLowerCase();
    if(!manifests[kind])return;
    const phone=phone10(item && item.phone),childAdmissionId=String(item && item.childAdmissionId || '').trim().slice(0,120);
    manifests[kind].push({phone:phone || '',childAdmissionId,valid:!!phone && /^[A-Za-z0-9_-]{8,120}$/.test(childAdmissionId)});
  });
  const notificationKind = ['morning','evening'].includes(String(payload.notificationKind || '').toLowerCase())
    ? String(payload.notificationKind).toLowerCase() : '';
  const reportDate = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.reportDate || '')) ? String(payload.reportDate) : '';
  const notificationEligible = payload.notificationEligible === true && reportNotificationWindowOpen(notificationKind, Date.now());
  const previousReports = new Map();
  if (notificationKind && reportDate) {
    const previous = await env.CHAT_DB.prepare('SELECT phone10, version, text, updated_at FROM report_current WHERE kind = ?').bind(notificationKind).all();
    (previous.results || []).forEach(row => previousReports.set(row.phone10, row));
  }

  const statements = [];
  const seen = new Set();
  const itemsByKey = new Map();
  const notificationCandidates = [];
  const nextRevisions = {};
  publicationKinds.forEach(kind => {
    const publication = publications[kind];
    const expected = Number(publication.expectedRevision);
    const next = expected + 1;
    nextRevisions[kind] = next;
  });

  reports.forEach(item => {
    const phone = phone10(item && item.phone);
    const kind = String(item && item.kind || '').trim().toLowerCase();
    if (!phone || !publicationKinds.includes(kind)) return;
    const publication = publications[kind];
    const childAdmissionId = String(item.childAdmissionId || '').trim().slice(0,120);
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(childAdmissionId)) return;
    const publicationRevision = nextRevisions[kind];
    const key = `${phone}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const text = String(item.text || '').trim().slice(0,30000);
    const incomingVersion = String(item.version || '').slice(0,180);
    const previous = kind === notificationKind ? previousReports.get(phone) : null;
    const previousVersion = String(previous && previous.version || '');
    const previousPublicationDate = (previousVersion.match(/\|d:(\d{4}-\d{2}-\d{2})$/) || [])[1] ||
      (previous && previousVersion.indexOf('v2:') !== 0 ? reportDateInMoscow(previous.updated_at) : '');
    // Use the explicit report event date, never updated_at: a profile sync can
    // refresh that timestamp before today's actual report is published.
    const isExplicitDailyPublication = kind === notificationKind && reportDate && text;
    const storedVersion = isExplicitDailyPublication ? `${incomingVersion}|d:${reportDate}` : incomingVersion;
    const row = { phone,kind,text,version:storedVersion,profileGeneration:'',childAdmissionId,
      revision:publicationRevision,publicationId:publication.publicationId };
    itemsByKey.set(key,row);

    if (kind === notificationKind && reportDate && text && notificationEligible) {
      const previousBaseVersion = previousVersion.replace(/\|d:\d{4}-\d{2}-\d{2}$/,'');
      const sameCanonicalTextOnVersionMigration = previous && incomingVersion.indexOf('v2:') === 0 &&
        previousVersion.indexOf('v2:') !== 0 &&
        canonicalReportTextForNotification(previous.text) === canonicalReportTextForNotification(text);
      const samePublishedReport = previous &&
        (previousBaseVersion === incomingVersion || sameCanonicalTextOnVersionMigration) &&
        previousPublicationDate === reportDate;
      if (!samePublishedReport) notificationCandidates.push({ phone,kind,reportDate,publicationId:publication.publicationId });
    }

    statements.push(env.CHAT_DB.prepare(`INSERT INTO report_current
      (phone10,kind,text,version,updated_at,profile_generation,child_admission_id,revision,publication_id)
      SELECT ?,?,?,?,?,?,?,?,?
      WHERE ((? = 0 AND NOT EXISTS (SELECT 1 FROM report_publication_state s WHERE s.kind=?))
        OR EXISTS (SELECT 1 FROM report_publication_state s WHERE s.kind=? AND s.revision=?
          AND (s.source_fingerprint IS NOT ? OR ?=1)))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.valid')<>1 OR NOT EXISTS (
          SELECT 1 FROM chat_profiles p WHERE p.phone10=json_extract(j.value,'$.phone')
            AND p.child_admission_id=json_extract(j.value,'$.childAdmissionId')))
        AND EXISTS (SELECT 1 FROM chat_profiles p WHERE p.phone10=?
          AND p.child_admission_id=?)
      ON CONFLICT(phone10,kind) DO UPDATE SET
        text=excluded.text,
        version=CASE WHEN report_current.text IS excluded.text
          AND substr(report_current.version,1,length(excluded.version))=excluded.version
          AND substr(report_current.version,length(excluded.version)+1,3)='|d:'
          THEN report_current.version ELSE excluded.version END,
        read_version=CASE WHEN COALESCE(TRIM(report_current.text),'')=''
          AND COALESCE(TRIM(excluded.text),'')<>'' THEN '' ELSE report_current.read_version END,
        updated_at=excluded.updated_at, profile_generation=excluded.profile_generation,
        child_admission_id=excluded.child_admission_id, revision=excluded.revision,
        publication_id=excluded.publication_id
      WHERE excluded.revision > report_current.revision
        AND EXISTS (SELECT 1 FROM chat_profiles p WHERE p.phone10=excluded.phone10
          AND p.child_admission_id=excluded.child_admission_id)
    `).bind(phone,kind,text,storedVersion,Number(item.updatedAt||0)||Date.now(),'',
      childAdmissionId,publicationRevision,publication.publicationId,
      Number(publication.expectedRevision),kind,kind,Number(publication.expectedRevision),publication.sourceFingerprint,repair?1:0,JSON.stringify(manifests[kind]),
      phone,childAdmissionId));
  });

  publicationKinds.forEach(kind => {
    const publication = publications[kind];
    const expected = Number(publication.expectedRevision);
    const next = expected + 1;
    const manifest = manifests[kind];
    statements.push(env.CHAT_DB.prepare(`INSERT INTO report_publication_state
      (kind,revision,source_fingerprint,publication_id,updated_at)
      SELECT ?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.valid')<>1 OR NOT EXISTS (
        SELECT 1 FROM chat_profiles p WHERE p.phone10=json_extract(j.value,'$.phone')
          AND p.child_admission_id=json_extract(j.value,'$.childAdmissionId')
      ))
      ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision,
        source_fingerprint=excluded.source_fingerprint,publication_id=excluded.publication_id,
        updated_at=excluded.updated_at
      WHERE report_publication_state.revision=?
        AND (report_publication_state.source_fingerprint IS NOT excluded.source_fingerprint OR ?=1)
    `).bind(kind,next,publication.sourceFingerprint,publication.publicationId,Date.now(),JSON.stringify(manifest),expected,repair?1:0));
  });

  if (statements.length) await env.CHAT_DB.batch(statements);

  const acceptedStates = {};
  const rejectedKinds = [];
  for (const kind of publicationKinds) {
    const current = await env.CHAT_DB.prepare('SELECT revision,source_fingerprint,publication_id FROM report_publication_state WHERE kind=?').bind(kind).first();
    const requested = publications[kind];
    const accepted = !!current && current.source_fingerprint === requested.sourceFingerprint &&
      Number(current.revision || 0) === Number(nextRevisions[kind]) && current.publication_id === requested.publicationId;
    acceptedStates[kind] = current ? { revision:Number(current.revision||0), sourceFingerprint:current.source_fingerprint||'', publicationId:current.publication_id||'' } : { revision:0,sourceFingerprint:'',publicationId:'' };
    if (!accepted) rejectedKinds.push(kind);
  }

  const appliedRows = new Set();
  for (const [key,item] of itemsByKey) {
    const active = await env.CHAT_DB.prepare(`SELECT 1 AS ok FROM report_current c
      JOIN chat_profiles p ON p.phone10=c.phone10
      WHERE c.phone10=? AND c.kind=? AND c.revision=? AND c.publication_id=?
        AND c.child_admission_id=? AND p.child_admission_id=c.child_admission_id
        AND c.text=? AND (c.version=? OR (
          substr(c.version,1,length(c.version)-13)=? AND substr(c.version,-13,3)='|d:'
          AND substr(c.version,-10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')) LIMIT 1`).bind(item.phone,item.kind,item.revision,item.publicationId,
          item.childAdmissionId,item.text,item.version,item.version).first();
    if (active) appliedRows.add(key);
  }
  const updated = appliedRows.size;
  const rejectedRows = itemsByKey.size - updated;
  const confirmedNotifications = notificationCandidates.filter(item => {
    const row = itemsByKey.get(`${item.phone}|${item.kind}`);
    return row && appliedRows.has(`${item.phone}|${item.kind}`) &&
      acceptedStates[item.kind] && acceptedStates[item.kind].publicationId === item.publicationId;
  });

  let queued = 0;
  if (confirmedNotifications.length) {
    const reserved = await env.CHAT_DB.batch(confirmedNotifications.map(item => env.CHAT_DB.prepare(`
      INSERT INTO report_push_dedup (phone10,kind,report_date,last_push_at) VALUES (?,?,?,?)
      ON CONFLICT(phone10,kind,report_date) DO UPDATE SET last_push_at=excluded.last_push_at
      WHERE excluded.last_push_at-report_push_dedup.last_push_at>=7200000
    `).bind(item.phone,item.kind,item.reportDate,Date.now())));
    const jobs=[];
    reserved.forEach((result,index)=>{if(!result.meta||Number(result.meta.changes||0)<1)return;queued++;jobs.push(notifyParentReportBestEffort(env,confirmedNotifications[index].phone,notificationKind));});
    if(jobs.length){
      const pushJob=Promise.allSettled(jobs).then(results=>{const failed=results.filter(result=>result.status==='rejected').length;if(failed)console.error('REPORT_PUSH_BATCH_FAILED',JSON.stringify({kind:notificationKind,failed,total:results.length}));});
      if(ctx&&typeof ctx.waitUntil==='function')ctx.waitUntil(pushJob);else await pushJob;
    }
  }
  return json({ ok:true, received:itemsByKey.size, updated, rejectedRows, rejectedKinds, states:acceptedStates, pushQueued:queued });
}

function reportNotificationWindowOpen(kindRaw, timestamp) {
  const kind = String(kindRaw || '').trim().toLowerCase();
  if (kind !== 'morning' && kind !== 'evening') return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false
  }).formatToParts(new Date(Number(timestamp || Date.now())));
  const hourPart = parts.find(part => part.type === 'hour');
  const hour = Number(hourPart && hourPart.value);
  if (!Number.isFinite(hour)) return false;
  if (kind === 'morning') return hour >= 13 && hour < 17;
  return hour >= 18 && hour < 24;
}

function canonicalReportTextForNotification(raw) {
  return String(raw || '')
    .replace(/(^|\n\s*\n)\s*[^:\n]{1,100}:\s*/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function reportDateInMoscow(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

async function notifyParentReportBestEffort(env, phone, kind) {
  if (!env.PUSH_WORKER || !env.MEDSI_CHAT_PUSH_SECRET) return;
  const label = kind === 'morning' ? 'утренний' : 'вечерний';
  const response = await env.PUSH_WORKER.fetch('https://medsi-push-worker.internal/notify', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.MEDSI_CHAT_PUSH_SECRET}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      role: 'parent',
      phone,
      notification: {
        title: 'Новый ' + label + ' отчёт',
        body: 'Отчёт по вашему ребёнку уже доступен в Медси Боте.',
        url: '/',
        tag: 'medsi-report-' + kind + '-' + phone
      }
    })
  });
  if (!response.ok) throw new Error(`Push HTTP ${response.status}`);
}

async function getParentCurrentReports(env, auth) {
  if (auth.role !== 'parent' || !auth.phone10) return json({ ok: false, message: 'Forbidden' }, 403);
  const result = await env.CHAT_DB.prepare(`
    SELECT kind, text, version, updated_at
    FROM report_current
    WHERE phone10 = ?
  `).bind(auth.phone10).all();
  return json({
    ok: true,
    reports: (result.results || []).map(row => ({
      kind: row.kind,
      text: row.text || '',
      version: row.version || '',
      updatedAt: Number(row.updated_at || 0)
    }))
  });
}

async function getOwnProfile(env, auth) {
  const profile = await env.CHAT_DB.prepare('SELECT phone10, parent_name, child_name, relationship, child_genitive FROM chat_profiles WHERE phone10 = ?').bind(auth.phone10).first();
  if (!profile) return json({ ok: false, code: 'CHAT_CLOSED', message: 'Чат недоступен' }, 410);
  return json({ ok: true, phone: profile.phone10, parentName: profile.parent_name || '', childName: profile.child_name || '' });
}

async function getParentUnreadState(env, auth) {
  if (auth.role !== 'parent' || !auth.phone10) return json({ ok: false, message: 'Forbidden' }, 403);
  const row = await env.CHAT_DB.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM chat_messages
      WHERE phone10 = ? AND side = 'educator' AND status = 'active' AND read_by_parent = 0
    ) AS has_unread
  `).bind(auth.phone10).first();
  return json({ ok: true, hasUnread: Number(row && row.has_unread || 0) === 1 });
}

async function captureScheduledReportHistory(env) {
  if (!env.APP_SCRIPT_URL || !env.CHAT_ADMIN_TOKEN) throw new Error('Report history scheduler is not configured');
  const response = await fetch(env.APP_SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'reportHistoryCapture', authorization: env.CHAT_ADMIN_TOKEN })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !payload.ok) {
    throw new Error(payload && payload.message || `Apps Script HTTP ${response.status}`);
  }
  return payload;
}

async function enqueueParentDeletion(request, env, auth, ctx) {
  if (auth.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  const operationId = parentDeletionId(payload.operationId);
  if (!phone || !operationId) {
    return json({ ok:false, message:'Некорректные данные удаления.' }, 400);
  }

  const byOperation = await env.CHAT_DB.prepare(`
    SELECT operation_id, phone10, status
    FROM parent_deletion_queue
    WHERE operation_id = ?
  `).bind(operationId).first();
  if (byOperation) {
    if (String(byOperation.phone10) !== phone) {
      return json({ ok:false, message:'Этот идентификатор удаления уже использован для другого профиля.' }, 409);
    }
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(drainParentDeletionQueue(env));
    return json({ ok:true, accepted:true, operationId, status:byOperation.status, duplicate:true });
  }

  const alreadyDeleting = await env.CHAT_DB.prepare(`
    SELECT operation_id, status
    FROM parent_deletion_queue
    WHERE phone10 = ? AND status IN ('pending','retry','processing','failed')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(phone).first();
  if (alreadyDeleting) {
    return json({
      ok:true,
      accepted:true,
      operationId:alreadyDeleting.operation_id,
      status:alreadyDeleting.status,
      duplicate:true
    });
  }

  const profile = await env.CHAT_DB.prepare(`
    SELECT phone10, parent_name, child_name, profile_generation
    FROM chat_profiles
    WHERE phone10 = ?
  `).bind(phone).first();
  if (!profile) {
    return json({ ok:false, code:'PROFILE_NOT_FOUND', message:'Ребёнок уже удалён.' }, 404);
  }

  const now = Date.now();
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare(`
      INSERT INTO parent_deletion_queue
        (operation_id, phone10, parent_name, child_name, profile_generation, status, attempts, last_error, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, '', '', ?, ?)
    `).bind(operationId, phone, String(profile.parent_name || ''), String(profile.child_name || ''),
      String(profile.profile_generation || ''), now, now),
    // Removing chat_profiles is the logical delete. Parent access and educator
    // lists close immediately, while messages stay until background cleanup.
    env.CHAT_DB.prepare('DELETE FROM chat_profiles WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM chat_pins WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM report_current WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM report_inactivity_state WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_outbox WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_attempts WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare("UPDATE parent_access_requests SET status='DENIED', decision='REVOKED', updated_at=? WHERE phone10 = ? AND status IN ('PENDING','APPROVED')").bind(now, phone)
  ]);
  parentAuthProfileCache.delete(phone);

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(drainParentDeletionQueue(env));
  return json({ ok:true, accepted:true, operationId, status:'pending' });
}

async function getParentDeletionStatus(env, auth, operationIdRaw) {
  if (auth.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
  const operationId = parentDeletionId(operationIdRaw);
  if (!operationId) return json({ ok:false, message:'Некорректный идентификатор удаления.' }, 400);
  const row = await env.CHAT_DB.prepare(`
    SELECT operation_id, phone10, status, attempts, last_error, result_json, updated_at
    FROM parent_deletion_queue
    WHERE operation_id = ?
  `).bind(operationId).first();
  if (!row) return json({ ok:true, status:'not_found', operationId });
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch (_) {}
  return json({
    ok:true,
    operationId:row.operation_id,
    phone:row.phone10,
    status:row.status,
    attempts:Number(row.attempts || 0),
    message:row.last_error || '',
    result,
    updatedAt:Number(row.updated_at || 0)
  });
}

async function listParentDeletionJobs(env, auth) {
  if (auth.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
  const rows = await env.CHAT_DB.prepare(`
    SELECT operation_id, phone10, child_name, status, attempts, last_error, updated_at
    FROM parent_deletion_queue
    WHERE status IN ('pending','retry','processing','failed')
    ORDER BY updated_at DESC
    LIMIT 20
  `).all();
  return json({ ok:true, operations:(rows.results || []).map(row => ({
    operationId:String(row.operation_id || ''), phone:String(row.phone10 || ''),
    childName:String(row.child_name || ''), status:String(row.status || ''),
    attempts:Number(row.attempts || 0), message:String(row.last_error || ''),
    updatedAt:Number(row.updated_at || 0)
  })) });
}

async function retryParentDeletion(request, env, auth, ctx) {
  if (auth.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
  const payload = await body(request) || {};
  const operationId = parentDeletionId(payload.operationId);
  if (!operationId) return json({ ok:false, message:'Некорректный идентификатор удаления.' }, 400);
  const row = await env.CHAT_DB.prepare('SELECT status FROM parent_deletion_queue WHERE operation_id=?').bind(operationId).first();
  if (!row) return json({ ok:false, message:'Операция удаления не найдена.' }, 404);
  if (row.status !== 'failed') return json({ ok:true, operationId, status:String(row.status || '') });
  await env.CHAT_DB.prepare(`UPDATE parent_deletion_queue SET status='retry', attempts=0, last_error='', updated_at=? WHERE operation_id=? AND status='failed'`).bind(Date.now(), operationId).run();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(drainParentDeletionQueue(env));
  return json({ ok:true, operationId, status:'retry' });
}

async function drainParentDeletionQueue(env) {
  if (!env.APP_SCRIPT_URL || !env.CHAT_ADMIN_TOKEN) {
    return { ok:false, message:'Parent deletion queue is not configured' };
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.CHAT_DB.prepare(`
    DELETE FROM parent_deletion_queue
    WHERE status = 'completed' AND updated_at < ?
  `).bind(cutoff).run();

  const staleProcessing = Date.now() - 10 * 60 * 1000;
  await env.CHAT_DB.prepare(`
    UPDATE parent_deletion_queue
    SET status='retry', last_error='Повтор после прерванной обработки', updated_at=?
    WHERE status='processing' AND updated_at < ?
  `).bind(Date.now(), staleProcessing).run();

  const rows = await env.CHAT_DB.prepare(`
    SELECT operation_id, phone10, parent_name, child_name, profile_generation, attempts, created_at
    FROM parent_deletion_queue
    WHERE status IN ('pending','retry')
    ORDER BY created_at, operation_id
    LIMIT 3
  `).all();

  const results = [];
  for (const row of (rows.results || [])) {
    const claimed = await env.CHAT_DB.prepare(`
      UPDATE parent_deletion_queue
      SET status='processing', attempts=attempts+1, updated_at=?
      WHERE operation_id=? AND status IN ('pending','retry')
    `).bind(Date.now(), row.operation_id).run();
    if (!claimed.meta || !claimed.meta.changes) continue;

    try {
      const response = await fetch(env.APP_SCRIPT_URL, {
        method:'POST',
        headers:{'content-type':'text/plain;charset=utf-8'},
        signal:AbortSignal.timeout(25000),
        body:JSON.stringify({
          action:'parentDeletionQueueProcess',
          authorization:env.CHAT_ADMIN_TOKEN,
          param:{
            operationId:row.operation_id,
            phone:row.phone10,
            parentName:row.parent_name,
            childName:row.child_name,
            profileGeneration:row.profile_generation,
            submittedAt:Number(row.created_at || 0)
          }
        })
      });
      const payload = await response.json().catch(() => null);
      const result = payload && payload.result ? payload.result : payload;
      if (!response.ok || !result || result.ok !== true ||
          (result.operationId && result.operationId !== row.operation_id) ||
          result.coreComplete !== true || result.cleanupComplete !== true) {
        const details = [];
        if (result && result.message) details.push(String(result.message));
        if (result && Array.isArray(result.pendingSteps) && result.pendingSteps.length) {
          details.push(`unfinished steps: ${result.pendingSteps.map(step => String(step).slice(0, 40)).join(', ')}`);
        }
        if (result && Array.isArray(result.cleanupErrors) && result.cleanupErrors.length) {
          details.push(`cleanup errors: ${result.cleanupErrors.map(item => String(item).slice(0, 140)).join('; ').slice(0, 360)}`);
        }
        const error = new Error(details.join(' | ') || `Apps Script did not confirm complete parent deletion (HTTP ${response.status})`);
        error.code = result && result.code || '';
        throw error;
      }
      await env.CHAT_DB.prepare(`
        UPDATE parent_deletion_queue
        SET status='completed', result_json=?, last_error='', updated_at=?
        WHERE operation_id=?
      `).bind(JSON.stringify(result), Date.now(), row.operation_id).run();
      results.push({ operationId:row.operation_id, status:'completed' });
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const next = error && (error.code === 'RECORD_CHANGED' || error.code === 'OPERATION_MISMATCH' || error.code === 'CHECKPOINT_UNRECOVERABLE')
        ? 'failed' : (attempts >= 12 ? 'failed' : 'retry');
      await env.CHAT_DB.prepare(`
        UPDATE parent_deletion_queue
        SET status=?, last_error=?, updated_at=?
        WHERE operation_id=?
      `).bind(next, String(error && error.message || error).slice(0, 500), Date.now(), row.operation_id).run();
      results.push({ operationId:row.operation_id, status:next });
      break;
    }
  }
  return { ok:true, results };
}

async function enqueueReportSubmission(request, env, auth, ctx) {
  if (auth.role !== 'educator') return json({ ok: false, message: 'Forbidden' }, 403);
  const payload = await body(request) || {};
  const submissionId = String(payload.submissionId || '').trim().slice(0, 120);
  const reportType = String(payload.reportType || '').trim().toLowerCase();
  const reportText = String(payload.text || '').trim();
  if (reportText.length > 50000) return json({ ok: false, message: 'Отчёт слишком большой: максимум 50 000 символов.' }, 400);
  if (!/^report_[A-Za-z0-9_-]{8,120}$/.test(submissionId)) return json({ ok: false, message: 'Некорректный идентификатор отправки.' }, 400);
  if (!['morning', 'evening', 'psychology'].includes(reportType) || !reportText) return json({ ok: false, message: 'Некорректные данные отчёта.' }, 400);
  const now = Date.now();
  await env.CHAT_DB.prepare(`
    INSERT INTO report_submission_queue (submission_id, report_type, report_text, status, attempts, last_error, result_json, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, '', '', ?, ?)
    ON CONFLICT(submission_id) DO NOTHING
  `).bind(submissionId, reportType, reportText, now, now).run();
  const saved = await env.CHAT_DB.prepare('SELECT report_type, report_text, status FROM report_submission_queue WHERE submission_id = ?').bind(submissionId).first();
  if (!saved || saved.report_type !== reportType || saved.report_text !== reportText) return json({ ok: false, message: 'Этот идентификатор уже использован для другого отчёта.' }, 409);
  // Never send an accepted receipt for an already terminally failed attempt.
  // A corrected report must use a new submission ID; the original remains
  // available for the educator failure notice and support diagnosis.
  if (saved.status === 'failed') return json({
    ok: false, code: 'REPORT_PREVIOUSLY_FAILED',
    message: 'Эта попытка обработки отчёта завершилась ошибкой. Проверьте текст или свяжитесь с Денисом.',
    submissionId, status: 'failed'
  }, 409);
  if (ctx) ctx.waitUntil(drainReportQueue(env));
  return json({ ok: true, accepted: true, submissionId, status: saved.status });
}

async function getReportSubmissionQueueStatus(env, auth, submissionId) {
  if (auth.role !== 'educator') return json({ ok: false, message: 'Forbidden' }, 403);
  const id = String(submissionId || '').trim();
  const row = await env.CHAT_DB.prepare(`SELECT submission_id, status, attempts, last_error, result_json, updated_at FROM report_submission_queue WHERE submission_id = ?`).bind(id).first();
  if (!row) return json({ ok: true, status: 'not_found', submissionId: id });
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch (_) {}
  return json({ ok: true, status: row.status, submissionId: id, attempts: Number(row.attempts || 0), message: row.last_error || '', result, updatedAt: Number(row.updated_at || 0) });
}

async function listRecentReportFailures(env, auth) {
  if (auth.role !== 'educator') return json({ ok: false, message: 'Forbidden' }, 403);
  const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
  // Metadata only: never return report text, submission IDs or error messages
  // (Apps Script validation errors may contain children's names).
  const rows = await env.CHAT_DB.prepare(`
    SELECT report_type, created_at, updated_at FROM report_submission_queue
    WHERE status = 'failed' AND created_at >= ?
      AND report_type IN ('morning', 'evening', 'psychology')
    ORDER BY created_at DESC LIMIT 30
  `).bind(since).all();
  return json({
    ok: true,
    failures: (rows.results || []).map(row => ({
      kind: String(row.report_type),
      createdAt: Number(row.created_at),
      failedAt: Number(row.updated_at)
    }))
  });
}

async function drainReportQueue(env) {
  if (!env.APP_SCRIPT_URL || !env.CHAT_ADMIN_TOKEN) return { ok: false, message: 'Report queue is not configured' };
  // Submission IDs are only needed while a result can still be recovered.
  // Periodic pruning keeps this operational queue bounded.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.CHAT_DB.prepare(`DELETE FROM report_submission_queue WHERE status IN ('completed','failed') AND updated_at < ?`).bind(cutoff).run();
  const staleProcessing = Date.now() - 10 * 60 * 1000;
  await env.CHAT_DB.prepare(`UPDATE report_submission_queue SET status='retry', last_error='Повтор после прерванной обработки', updated_at=? WHERE status='processing' AND updated_at < ?`).bind(Date.now(), staleProcessing).run();
  const rows = await env.CHAT_DB.prepare(`SELECT submission_id, report_type, report_text, attempts, created_at FROM report_submission_queue WHERE status IN ('pending','retry') ORDER BY created_at, submission_id LIMIT 5`).all();
  const results = [];
  for (const row of (rows.results || [])) {
    // A newer report must never overtake an earlier one. Concurrent drains
    // may run after separate submissions or on a scheduled invocation.
    const claimed = await env.CHAT_DB.prepare(`
      UPDATE report_submission_queue SET status='processing', attempts=attempts+1, updated_at=?
      WHERE submission_id=? AND status IN ('pending','retry')
        AND NOT EXISTS (
          SELECT 1 FROM report_submission_queue AS earlier
          WHERE earlier.status IN ('pending','retry','processing')
            AND (earlier.created_at < report_submission_queue.created_at
              OR (earlier.created_at = report_submission_queue.created_at
                AND earlier.submission_id < report_submission_queue.submission_id))
        )
        AND NOT EXISTS (
          SELECT 1 FROM report_submission_queue AS active WHERE active.status='processing'
        )
    `).bind(Date.now(), row.submission_id).run();
    if (!claimed.meta || !claimed.meta.changes) break;
    try {
      const response = await fetch(env.APP_SCRIPT_URL, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({ action: 'reportQueueProcess', authorization: env.CHAT_ADMIN_TOKEN, param: { reportType: row.report_type, text: row.report_text, submissionId: row.submission_id, submittedAt: Number(row.created_at) } })
      });
      const payload = await response.json().catch(() => null);
      const result = payload && payload.result ? payload.result : payload;
      if (response.ok && result && result.ok === true && result.processing === true) {
        // A timed-out request can still be running in Apps Script. Wait for
        // its idempotent result without spending the transient-error budget.
        await env.CHAT_DB.prepare(`UPDATE report_submission_queue SET status='retry', attempts=MAX(attempts-1,0), last_error='Apps Script is still processing', updated_at=? WHERE submission_id=?`).bind(Date.now(), row.submission_id).run();
        results.push({ submissionId:row.submission_id, status:'retry' });
        break;
      }
      if (!response.ok || !result || result.ok !== true || result.processing ||
          (result.submissionId && result.submissionId !== row.submission_id)) {
        const failure = new Error(result && result.message || `Apps Script did not confirm report save (HTTP ${response.status})`);
        // A verified format error will never succeed on an identical retry.
        // Mark it terminal immediately instead of retrying eight times.
        failure.permanent = !!(response.ok && result && result.code === 'REPORT_FORMAT_ERROR');
        throw failure;
      }
      await env.CHAT_DB.prepare(`UPDATE report_submission_queue SET status='completed', result_json=?, last_error='', updated_at=? WHERE submission_id=?`).bind(JSON.stringify(result), Date.now(), row.submission_id).run();
      results.push({ submissionId: row.submission_id, status: 'completed' });
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const next = (error && error.permanent) || attempts >= 8 ? 'failed' : 'retry';
      await env.CHAT_DB.prepare(`UPDATE report_submission_queue SET status=?, last_error=?, updated_at=? WHERE submission_id=?`).bind(next, String(error && error.message || error).slice(0, 500), Date.now(), row.submission_id).run();
      results.push({ submissionId: row.submission_id, status: next });
      break;
    }
  }
  return { ok: true, results };
}

// REPORTS remains the authority for which parents exist.  This endpoint is
// deliberately available only to Apps Script: it upserts active profiles and,
// on a full reconciliation, removes every trace of parents no longer present
// in the table.
async function reconcileProfiles(request, env) {
  const payload = await body(request) || {};
  // A truncated or malformed full snapshot must never become a deletion list.
  // Reject it before the first write; the caller can safely retry the sync.
  if (!Array.isArray(payload.profiles) || payload.profiles.length > 500 ||
      payload.profiles.some(item => !item || !phone10(item.phone))) {
    return json({ ok:false, code:'INVALID_PROFILE_SNAPSHOT', message:'Expected a complete profile array of at most 500 valid entries' }, 400);
  }
  const profiles = payload.profiles;
  const full = payload.full === true;
  const deletingRows = await env.CHAT_DB.prepare(`
    SELECT phone10
    FROM parent_deletion_queue
    WHERE status IN ('pending','retry','processing','failed')
  `).all();
  const deleting = new Set((deletingRows.results || []).map(row => String(row.phone10 || '')).filter(Boolean));
  const recentlyDeletedRows = await env.CHAT_DB.prepare(`
    SELECT DISTINCT phone10
    FROM parent_deletion_queue
    WHERE status = 'completed' AND updated_at >= ?
  `).bind(Date.now() - 30 * 24 * 60 * 60 * 1000).all();
  const recentlyDeleted = new Set((recentlyDeletedRows.results || []).map(row => String(row.phone10 || '')).filter(Boolean));
  const active = new Map();
  profiles.forEach(item => {
    const phone = phone10(item && item.phone);
    if (!phone || deleting.has(phone)) return;
    const profileGeneration = registrationId(item.profileGeneration) || '';
    // Old code may still have a REPORTS snapshot in flight when a discharge
    // finishes. Such a snapshot has no generation and must not recreate the
    // just-removed profile. A fresh Worker registration always has a new ID.
    if (recentlyDeleted.has(phone) && !profileGeneration) return;
    active.set(phone, {
      parentName: String(item.parentName || '').trim().slice(0, 300),
      childName: String(item.childName || '').trim().slice(0, 300),
      relationship: String(item.relationship || 'Родитель').trim().slice(0, 30),
      childGenitive: String(item.childGenitive || '').trim().slice(0, 100),
      profileGeneration: profileGeneration,
      childAdmissionId: /^[A-Za-z0-9_-]{8,120}$/.test(String(item.childAdmissionId || '').trim())
        ? String(item.childAdmissionId).trim() : ''
    });
  });

  const statements = [];
  let rosterOrder = 0;
  active.forEach((profile, phone) => {
    const position = rosterOrder++;
    statements.push(env.CHAT_DB.prepare(`
      INSERT INTO chat_profiles
        (phone10, parent_name, child_name, relationship, child_genitive, profile_generation, child_admission_id)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE ? = ''
        OR EXISTS (
          SELECT 1 FROM parent_registration_attempts a
          WHERE a.attempt_id = ? AND a.phone10 = ? AND a.status = 'COMPLETED'
        )
        OR EXISTS (
          SELECT 1 FROM chat_profiles current
          WHERE current.phone10 = ? AND current.profile_generation = ?
        )
      ON CONFLICT(phone10) DO UPDATE SET parent_name = excluded.parent_name,
        child_name = excluded.child_name, relationship = excluded.relationship,
        child_genitive = excluded.child_genitive,
        profile_generation = CASE
          WHEN excluded.profile_generation <> '' AND
            (chat_profiles.profile_generation = '' OR chat_profiles.profile_generation = excluded.profile_generation)
          THEN excluded.profile_generation ELSE chat_profiles.profile_generation END,
        child_admission_id = CASE
          WHEN excluded.child_admission_id <> '' AND
            (chat_profiles.child_admission_id = '' OR chat_profiles.child_admission_id = excluded.child_admission_id)
          THEN excluded.child_admission_id ELSE chat_profiles.child_admission_id END
      WHERE (excluded.profile_generation = '' OR chat_profiles.profile_generation = ''
        OR chat_profiles.profile_generation = excluded.profile_generation)
        AND (excluded.child_admission_id = '' OR chat_profiles.child_admission_id = ''
          OR chat_profiles.child_admission_id = excluded.child_admission_id)
    `).bind(phone, profile.parentName, profile.childName, profile.relationship, profile.childGenitive,
      profile.profileGeneration, profile.childAdmissionId, profile.profileGeneration,
      profile.profileGeneration, phone, phone, profile.profileGeneration));
    statements.push(env.CHAT_DB.prepare(`
      INSERT INTO report_inactivity_state (phone10, first_seen_at, roster_order)
      VALUES (?, ?, ?)
      ON CONFLICT(phone10) DO UPDATE SET roster_order = excluded.roster_order
      WHERE report_inactivity_state.roster_order IS NOT excluded.roster_order
    `).bind(phone, Date.now(), position));
  });
  if (statements.length) await env.CHAT_DB.batch(statements);

  let removed = 0;
  if (full) {
    const current = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles').all();
    const stale = (current.results || []).map(row => row.phone10).filter(phone => !active.has(phone));
    if (stale.length) {
      const deletions = [];
      stale.forEach(phone => {
        deletions.push(env.CHAT_DB.prepare('DELETE FROM chat_messages WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM chat_pins WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM report_snapshots WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM report_current WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM report_inactivity_state WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare("UPDATE parent_access_requests SET status='DENIED', decision='REVOKED', updated_at=? WHERE phone10 = ? AND status IN ('PENDING','APPROVED')").bind(Date.now(), phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM parent_registration_outbox WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM parent_registration_attempts WHERE phone10 = ?').bind(phone));
        deletions.push(env.CHAT_DB.prepare('DELETE FROM chat_profiles WHERE phone10 = ?').bind(phone));
      });
      await env.CHAT_DB.batch(deletions);
      stale.forEach(phone => parentAuthProfileCache.delete(phone));
      removed = stale.length;
    }
  }
  return json({ ok: true, active: active.size, removed, full });
}

async function listProfilePhones(env) {
  const rows = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles ORDER BY phone10').all();
  return json({ ok: true, phones: (rows.results || []).map(row => row.phone10) });
}

async function getProfileForAdmin(env, phoneRaw) {
  const phone = phone10(phoneRaw);
  if (!phone) return json({ ok: false, message: 'A valid phone is required.' }, 400);
  const profile = await env.CHAT_DB.prepare(
    'SELECT phone10, parent_name, child_name, relationship, child_genitive FROM chat_profiles WHERE phone10 = ?'
  ).bind(phone).first();
  return json({ ok: true, profile: profile ? {
    phone: '8' + profile.phone10,
    parentName: profile.parent_name || '',
    childName: profile.child_name || ''
  } : null });
}

// These two lifecycle operations are intentionally admin-only.  REPORTS is
// the authority; Apps Script invokes them after a protected snapshot/diff.
// Neither endpoint is reachable through the browser chat session.
async function moveProfilePhone(request, env) {
  const payload = await body(request) || {};
  const from = phone10(payload.fromPhone);
  const to = phone10(payload.toPhone);
  if (!from || !to || from === to) return json({ ok: false, message: 'Two different valid phones are required.' }, 400);

  const target = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles WHERE phone10 = ?').bind(to).first();
  if (target) return json({ ok: false, message: 'Target phone already has a profile.' }, 409);

  const before = await env.CHAT_DB.prepare('SELECT COUNT(*) AS messages FROM chat_messages WHERE phone10 = ?').bind(from).first();
  const parentName = String(payload.parentName || '').trim().slice(0, 300);
  const childName = String(payload.childName || '').trim().slice(0, 300);
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare('UPDATE parent_auth_profiles SET phone10=?,updated_at=? WHERE phone10=?').bind(to, Date.now(), from),
    env.CHAT_DB.prepare('UPDATE parent_auth_challenges SET consumed_at=? WHERE phone10=? AND consumed_at IS NULL').bind(Date.now(), from),
    env.CHAT_DB.prepare('UPDATE chat_messages SET phone10 = ? WHERE phone10 = ?').bind(to, from),
    env.CHAT_DB.prepare('UPDATE chat_pins SET phone10 = ? WHERE phone10 = ?').bind(to, from),
    env.CHAT_DB.prepare('UPDATE report_snapshots SET phone10 = ? WHERE phone10 = ?').bind(to, from),
    env.CHAT_DB.prepare('UPDATE report_current SET phone10 = ? WHERE phone10 = ?').bind(to, from),
    env.CHAT_DB.prepare('UPDATE report_inactivity_state SET phone10 = ? WHERE phone10 = ?').bind(to, from),
    env.CHAT_DB.prepare('UPDATE chat_profiles SET phone10 = ?, parent_name = ?, child_name = ? WHERE phone10 = ?').bind(to, parentName, childName, from),
    env.CHAT_DB.prepare('INSERT INTO chat_profiles (phone10, parent_name, child_name) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM chat_profiles WHERE phone10 = ?)').bind(to, parentName, childName, to),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_outbox WHERE phone10 = ?').bind(from),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_outbox WHERE phone10 = ?').bind(to),
    env.CHAT_DB.prepare("UPDATE parent_access_requests SET status='DENIED', decision='REVOKED', updated_at=? WHERE phone10 = ? AND status IN ('PENDING','APPROVED')").bind(Date.now(), from),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_attempts WHERE phone10 = ?').bind(from)
  ]);
  parentAuthProfileCache.delete(from);
  parentAuthProfileCache.delete(to);
  return json({ ok: true, fromPhone: from, toPhone: to, movedMessages: Number(before && before.messages || 0) });
}

// Returns S3 object keys alongside D1 deletion so Apps Script can enqueue a
// protected Timeweb purge.  The queue makes a transient S3 failure retryable
// without restoring the deleted parent's chat visibility.
async function deleteProfilePhone(request, env) {
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  if (!phone) return json({ ok: false, message: 'A valid phone is required.' }, 400);
  const media = await env.CHAT_DB.prepare("SELECT file_id FROM chat_messages WHERE phone10 = ? AND file_id LIKE 's3:%'").bind(phone).all();
  const s3Keys = [...new Set((media.results || []).map(row => String(row.file_id || '').slice(3)).filter(Boolean))];
  const legacyMedia = await env.CHAT_DB.prepare("SELECT file_id FROM chat_messages WHERE phone10 = ? AND file_id LIKE 'kv:%'").bind(phone).all();
  const kvKeys = [...new Set((legacyMedia.results || []).map(row => String(row.file_id || '').slice(3)).filter(Boolean))];
  for (const key of kvKeys) await env.CHAT_MEDIA.delete(key);
  await env.CHAT_DB.batch([
    env.CHAT_DB.prepare('DELETE FROM chat_messages WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM chat_pins WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM report_snapshots WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM report_current WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM report_inactivity_state WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM chat_profiles WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_outbox WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare('DELETE FROM parent_registration_attempts WHERE phone10 = ?').bind(phone),
    env.CHAT_DB.prepare("UPDATE parent_access_requests SET status='DENIED', decision='REVOKED', updated_at=? WHERE phone10 = ? AND status IN ('PENDING','APPROVED')").bind(Date.now(), phone)
  ]);
  parentAuthProfileCache.delete(phone);
  return json({ ok: true, phone, s3Keys, deletedKvKeys:kvKeys.length });
}

// Read-only first half of the deletion protocol.  Apps Script persists this
// result in its own retry queue before calling deleteProfilePhone, so a later
// S3 outage cannot make attachment keys disappear with the D1 records.
async function profileS3Keys(request, env) {
  const payload = await body(request) || {};
  const phone = phone10(payload.phone);
  if (!phone) return json({ ok: false, message: 'A valid phone is required.' }, 400);
  const media = await env.CHAT_DB.prepare("SELECT file_id FROM chat_messages WHERE phone10 = ? AND file_id LIKE 's3:%'").bind(phone).all();
  const s3Keys = [...new Set((media.results || []).map(row => String(row.file_id || '').slice(3)).filter(Boolean))];
  return json({ ok: true, phone, s3Keys });
}

async function notifyChatMessageBestEffort(env, phone, side, type, text) {
  if (!env.MEDSI_CHAT_PUSH_SECRET) return;

  const targetRole = side === 'parent' ? 'educator' : 'parent';

  let childName = '';
  let parentName = '';
  let relationship = 'Родитель';
  let childGenitive = '';
  if (side === 'parent') {
    try {
      const profile = await env.CHAT_DB.prepare(
        'SELECT child_name, parent_name, relationship, child_genitive FROM chat_profiles WHERE phone10 = ? LIMIT 1'
      ).bind(phone).first();
      childName = String(profile && profile.child_name || '').trim();
      parentName = String(profile && profile.parent_name || '').trim();
      relationship = String(profile && profile.relationship || 'Родитель').trim();
      childGenitive = String(profile && profile.child_genitive || '').trim();
    } catch (error) {
      console.error('CHAT_PUSH_PROFILE_LOOKUP_FAILED', error);
    }
  }

  const bodyText = type === 'image'
    ? 'Новое фото в чате'
    : type === 'video'
      ? 'Новое видео в чате'
      : (text ? String(text).slice(0, 180) : 'Новое сообщение в чате');

  const notification = {
    title: side === 'parent'
      ? (childGenitive
          ? `${relationship} ${childGenitive}`
          : `${relationship}${parentName ? `: ${parentName}` : ''}${childName ? ` · ребёнок: ${childName}` : ''}`)
      : 'Детское Отделение Медси',
    body: bodyText,
    url: targetRole === 'educator' ? '/tutors' : '/',
    tag: 'medsi-chat-' + phone
  };

  if (!env.PUSH_WORKER) {
    throw new Error('PUSH_WORKER service binding is not configured');
  }

  const response = await env.PUSH_WORKER.fetch(
    'https://medsi-push-worker.internal/notify',
    {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.MEDSI_CHAT_PUSH_SECRET}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        role: targetRole,
        phone: targetRole === 'parent' ? phone : '',
        notification
      })
    }
  );

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Push HTTP ${response.status}: ${message.slice(0, 300)}`);
  }
}

async function addMessage(request, env, auth, ctx) {
  const payload = await body(request);
  const phone = assertPhone(payload && payload.phone, env);
  const profile = await env.CHAT_DB.prepare('SELECT phone10 FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!profile) return json({ ok:false, code:'CHAT_CLOSED', message:'Chat is closed' }, 410);
  const side = auth.role;
  const type = String(payload && payload.type || 'text');
  if (side !== 'parent' && side !== 'educator') return json({ ok: false, message: 'Bad side' }, 400);
  const text = String(payload && payload.text || '').trim().slice(0, 4000);
  const fileId = String(payload && payload.fileId || '').trim().slice(0, 200);
  const clientMessageId = String(payload && payload.clientMessageId || '').trim().slice(0, 200);
  const replyToKey = String(payload && payload.replyToKey || '').trim().slice(0, 200);
  if (!text && !fileId) return json({ ok: false, message: 'Text or file is required' }, 400);
  if (!['text', 'image', 'video'].includes(type)) return json({ ok: false, message: 'Bad message type' }, 400);
  if (replyToKey) {
    const replyTarget = await env.CHAT_DB.prepare(
      "SELECT message_key FROM chat_messages WHERE message_key = ? AND phone10 = ? AND status = 'active'"
    ).bind(replyToKey, phone).first();
    if (!replyTarget) return json({ ok: false, message: 'Reply target does not belong to this chat' }, 400);
  }

  const now = Date.now();
  const key = `${now}-${side}-${crypto.randomUUID()}`;
  try {
    await env.CHAT_DB.prepare(`
      INSERT INTO chat_messages
        (message_key, client_message_id, phone10, side, type, text, file_id, reply_to_key, created_at, read_by_parent, read_by_educator)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(key, clientMessageId, phone, side, type, text, fileId, replyToKey, now, side === 'parent' ? 1 : 0, side === 'educator' ? 1 : 0).run();
  } catch (error) {
    // A lost response or a repeated POST can race with the first insert.
    // The partial unique index makes the client id the operation's idempotency
    // key while preserving unlimited ordinary messages with an empty id.
    if (!clientMessageId) throw error;
    const existing = await env.CHAT_DB.prepare('SELECT * FROM chat_messages WHERE phone10 = ? AND client_message_id = ?').bind(phone, clientMessageId).first();
    if (!existing) throw error;
    return json({ ok: true, duplicate: true, message: messageFromRow(existing) });
  }
  const pushJob = notifyChatMessageBestEffort(env, phone, side, type, text)
    .catch(error => console.error('CHAT_PUSH_FAILED', error));

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(pushJob);
  } else {
    await pushJob;
  }

  return json({ ok: true, message: { messageKey: key, phone, side, type, text, fileId, reply: replyToKey ? { messageKey: replyToKey } : null, timestamp: now } });
}

async function listParents(env) {
  const result = await env.CHAT_DB.prepare(`
    SELECT phone10, parent_name, child_name, relationship
    FROM chat_profiles
    ORDER BY child_name COLLATE NOCASE ASC, parent_name COLLATE NOCASE ASC, phone10 ASC
  `).all();

  const parents = (result.results || []).map(row => ({
    phone: row.phone10,
    parentName: row.parent_name || '',
    childName: row.child_name || '',
    relationship: row.relationship || 'Родитель'
  }));

  return json({ ok: true, parents });
}

async function listChats(env, bucket) {
  const unreadOnly = bucket === 'unread';
  const readOnly = bucket === 'read';
  const condition = unreadOnly
    ? "WHERE unread.has_unread = 1 OR pins.bucket = 'unread'"
    : readOnly
      ? "WHERE unread.has_unread = 0 OR pins.bucket = 'read'"
      : '';
  const result = await env.CHAT_DB.prepare(`
    WITH latest AS (
      SELECT m1.phone10, m1.id AS last_id
      FROM chat_messages m1
      WHERE m1.status = 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM chat_messages m2
          WHERE m2.phone10 = m1.phone10
            AND m2.status = 'active'
            AND (
              m2.created_at > m1.created_at
              OR (m2.created_at = m1.created_at AND m2.id > m1.id)
            )
        )
    ), unread AS (
      SELECT phone10,
        MAX(CASE WHEN side = 'parent' AND read_by_educator = 0 THEN 1 ELSE 0 END) AS has_unread
      FROM chat_messages WHERE status = 'active'
      GROUP BY phone10
    )
    SELECT m.phone10, p.parent_name, p.child_name, p.relationship, m.side AS last_side, m.type AS last_type, m.text AS last_text,
      m.created_at, unread.has_unread, pins.bucket AS pinned_bucket
    FROM latest
    JOIN chat_messages m ON m.id = latest.last_id
    JOIN chat_profiles p ON p.phone10 = m.phone10
    JOIN unread ON unread.phone10 = m.phone10
    LEFT JOIN chat_pins pins ON pins.phone10 = m.phone10
    ${condition}
    ORDER BY CASE WHEN pins.bucket = ? THEN 1 ELSE 0 END DESC, m.created_at DESC, m.id DESC
  `).bind(bucket === 'read' ? 'read' : 'unread').all();
  const chats = result.results.map(row => ({
    phone: row.phone10,
    parentName: row.parent_name,
    childName: row.child_name,
    relationship: row.relationship || 'Родитель',
    lastSide: row.last_side,
    lastType: row.last_type || 'text',
    lastText: row.last_text,
    hasUnread: Boolean(row.has_unread),
    pinnedBucket: row.pinned_bucket || ''
  }));

  return json({ ok: true, chats });
}

async function getThread(env, rawPhone, beforeRaw, limitRaw) {
  const phone = assertPhone(rawPhone, env);
  const limit = Math.max(1, Math.min(150, Number(limitRaw) || 50));
  const beforeKey = String(beforeRaw || '').trim();
  const profile = await env.CHAT_DB.prepare('SELECT * FROM chat_profiles WHERE phone10 = ?').bind(phone).first();
  if (!profile) return json({ ok:false, message:'Контакт уже удалён.' }, 404);
  const result = await env.CHAT_DB.prepare(`
    WITH boundary AS (
      SELECT created_at, id
      FROM chat_messages
      WHERE message_key = ?
    )
    SELECT m.*
    FROM chat_messages m
    WHERE m.phone10 = ? AND m.status = 'active'
      AND (
        ? = ''
        OR NOT EXISTS (SELECT 1 FROM boundary)
        OR m.created_at < (SELECT created_at FROM boundary)
        OR (
          m.created_at = (SELECT created_at FROM boundary)
          AND m.id < (SELECT id FROM boundary)
        )
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).bind(beforeKey, phone, beforeKey, limit + 1).all();
  const hasMore = result.results.length > limit;
  const rows = hasMore ? result.results.slice(0, limit) : result.results;
  const messages = rows.reverse().map(messageFromRow);
  const byKey = new Map(messages.map(message => [message.messageKey, message]));
  const missingReplyKeys = [...new Set(messages
    .map(message => message.reply && message.reply.messageKey)
    .filter(key => key && !byKey.has(key)))];
  if (missingReplyKeys.length) {
    const placeholders = missingReplyKeys.map(() => '?').join(',');
    const referenced = await env.CHAT_DB.prepare(
      `SELECT * FROM chat_messages WHERE phone10 = ? AND message_key IN (${placeholders}) AND status = 'active'`
    ).bind(phone, ...missingReplyKeys).all();
    referenced.results.forEach(row => {
      const message = messageFromRow(row);
      byKey.set(message.messageKey, message);
    });
  }
  messages.forEach(message => {
    if (!message.reply || !message.reply.messageKey) return;
    const target = byKey.get(message.reply.messageKey);
    if (target) message.reply = { messageKey:target.messageKey, side:target.side, type:target.type, text:target.text, fileId:target.fileId };
  });
  return json({ ok: true, phone, parentName: profile.parent_name, childName: profile.child_name,
    relationship: profile.relationship || 'Родитель', messages, hasMore });
}

async function markEducatorRead(env, rawPhone) {
  const phone = assertPhone(rawPhone, env);
  await env.CHAT_DB.prepare('UPDATE chat_messages SET read_by_educator = 1 WHERE phone10 = ? AND side = \'parent\'').bind(phone).run();
  return json({ ok: true });
}

async function markEducatorUnread(env, rawPhone) {
  const phone = assertPhone(rawPhone, env);
  await env.CHAT_DB.prepare(
    "UPDATE chat_messages SET read_by_educator = 0 WHERE phone10 = ? AND side = 'parent' AND status = 'active'"
  ).bind(phone).run();
  return json({ ok: true });
}

async function markParentRead(env, rawPhone) {
  const phone = assertPhone(rawPhone, env);
  await env.CHAT_DB.prepare("UPDATE chat_messages SET read_by_parent = 1 WHERE phone10 = ? AND side = 'educator'").bind(phone).run();
  return json({ ok: true });
}

async function setPin(request, env, rawPhone) {
  const phone = assertPhone(rawPhone, env);
  const payload = await body(request);
  const bucket = String(payload && payload.bucket || '').trim();
  if (!['read', 'unread', ''].includes(bucket)) return json({ ok: false, message: 'Bad pin bucket' }, 400);
  if (!bucket) {
    await env.CHAT_DB.prepare('DELETE FROM chat_pins WHERE phone10 = ?').bind(phone).run();
    return json({ ok: true, pinned: false });
  }
  await env.CHAT_DB.prepare('INSERT INTO chat_pins (phone10, bucket, updated_at) VALUES (?, ?, ?) ON CONFLICT(phone10) DO UPDATE SET bucket = excluded.bucket, updated_at = excluded.updated_at').bind(phone, bucket, Date.now()).run();
  return json({ ok: true, pinned: true, bucket });
}

async function mutateMessage(request, env, kind, rawKey, auth) {
  const key = String(rawKey || '').trim();
  const payload = await body(request);
  if (!key) return json({ ok: false, message: 'Message key is required' }, 400);
  const row = await env.CHAT_DB.prepare('SELECT * FROM chat_messages WHERE message_key = ?').bind(key).first();
  if (!row) return json({ ok: false, message: 'Message not found' }, 404);
  if (auth.role === 'parent' && row.phone10 !== auth.phone10) {
    return json({ ok: false, message: 'Forbidden' }, 403);
  }
  if (kind === 'reaction') {
    const reaction = String(payload && payload.reaction || '').trim();
    const allowedReactions = new Set(['❤️', '👍', '👌', '🙏', '🥰', '😁', '🔥']);

    if (reaction && !allowedReactions.has(reaction)) {
      return json({ ok: false, message: 'Bad reaction' }, 400);
    }

    await env.CHAT_DB.prepare('UPDATE chat_messages SET reaction = ? WHERE message_key = ?').bind(row.reaction === reaction ? '' : reaction, key).run();
    return json({ ok: true, reaction: row.reaction === reaction ? '' : reaction });
  }

  const actor = auth.role;
  const educatorDeletingParentMessage = kind === 'delete' && actor === 'educator' && row.side === 'parent';
  if (actor !== row.side && !educatorDeletingParentMessage) {
    return json({ ok: false, message: 'Only own messages can be changed' }, 403);
  }
  if (kind === 'edit') {
    const text = String(payload && payload.text || '').trim().slice(0, 4000);
    if (!text) return json({ ok: false, message: 'Text is required' }, 400);
    await env.CHAT_DB.prepare('UPDATE chat_messages SET text = ?, edited_at = ? WHERE message_key = ?').bind(text, Date.now(), key).run();
    return json({ ok: true, text });
  }
  await env.CHAT_DB.prepare("UPDATE chat_messages SET status = 'deleted' WHERE message_key = ?").bind(key).run();
  return json({ ok: true });
}

export default {
  async scheduled(controller, env, ctx) {
    if (controller.cron !== '* * * * *') ctx.waitUntil(captureScheduledReportHistory(env));
    ctx.waitUntil(drainReportQueue(env));
    ctx.waitUntil(drainParentDeletionQueue(env));
  },
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
      return serveMedia(env, decodeURIComponent(url.pathname.slice('/media/'.length)));
    }
    if (request.method === 'GET' && url.pathname === '/admin/bot-logs') {
      return json({ ok: false }, 410);
    }
    if (url.pathname.startsWith('/admin/')) {
      if (!await requireAdmin(request, env)) return json({ ok: false, message: 'Unauthorized' }, 401);
      if (request.method === 'POST' && url.pathname === '/admin/import') return importBatch(request, env);
      if (request.method === 'GET' && url.pathname === '/admin/export') return exportChatMessages(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/reconcile') return reconcileProfiles(request, env);
      if (request.method === 'GET' && url.pathname === '/admin/profile-phones') return listProfilePhones(env);
      if (request.method === 'GET' && url.pathname.startsWith('/admin/profile/')) return getProfileForAdmin(env, url.pathname.slice('/admin/profile/'.length));
      if (request.method === 'POST' && url.pathname === '/admin/move-profile-phone') return moveProfilePhone(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/profile-s3-keys') return profileS3Keys(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/delete-profile-phone') return deleteProfilePhone(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/report-snapshots') return upsertReportSnapshots(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/report-current') return upsertCurrentReports(request, env, ctx);
      if (request.method === 'GET' && url.pathname === '/admin/report-current/state') return getCurrentReportPublicationState(env);
      if (request.method === 'GET' && url.pathname === '/admin/parent-registration-outbox') return listParentRegistrationOutbox(env);
      if (request.method === 'POST' && url.pathname === '/admin/parent-registration-outbox/ack') return acknowledgeParentRegistrationOutbox(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/parent-registration-outbox/fail') return failParentRegistrationOutbox(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/report-inactivity/sync') return syncReportInactivity(request, env);
      if (request.method === 'POST' && url.pathname === '/admin/report-inactivity/remove') return removeReportInactivity(request, env);
      if (request.method === 'GET' && url.pathname === '/admin/report-current/versions') return getCurrentReportVersions(env);
      if (request.method === 'GET' && url.pathname === '/admin/parent-access-requests') return listParentAccessRequests(env);
      if (request.method === 'POST' && url.pathname === '/admin/parent-access-requests/decision') return decideParentAccessRequest(request, env);
      if (request.method === 'GET' && url.pathname === '/admin/verify') return verifySnapshot(env);
      return json({ ok: false, message: 'Not found' }, 404);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-registration') {
      return registerParent(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/lab/parent-registration/status') {
      return getParentRegistrationStatus(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-passkeys/authentication/options') {
      const { parentPasskeyAuthenticationOptions } = await import('./parent-passkeys.mjs');
      return parentPasskeyAuthenticationOptions(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-passkeys/authentication/verify') {
      const { parentPasskeyAuthenticationVerify } = await import('./parent-passkeys.mjs');
      return parentPasskeyAuthenticationVerify(request, env, { issueParentSession: (phone, secret) => issueParentSession(phone, secret, env) });
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-auth/request') {
      return requestParentAccess(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-auth/status') {
      return getParentAccessStatus(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-preview') {
      const educator = await authorized(request, env);
      if (!educator || educator.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
      const payload = await body(request) || {};
      const phone = phone10(payload.phone);
      if (!phone || !env.LAB_D1_SESSION_SECRET) return json({ ok:false, message:'Не удалось открыть профиль.' }, 400);
      const profile = await env.CHAT_DB.prepare('SELECT phone10,parent_name,child_name FROM chat_profiles WHERE phone10=?').bind(phone).first();
      const generation = await getParentAuthProfile(env, phone);
      if (!profile || !generation) return json({ ok:false, message:'Активный профиль ребёнка не найден.' }, 404);
      const expiresAt = Date.now() + 15 * 60 * 1000;
      const encoded = b64url(new TextEncoder().encode(JSON.stringify({role:'parent',phone10:phone,exp:expiresAt,authGeneration:generation.generation_id,preview:true,version:'cf-parent-preview-v1'})));
      const token = encoded + '.' + await hmac(env.LAB_D1_SESSION_SECRET, encoded);
      return json({ok:true,phone:profile.phone10,parentName:profile.parent_name||'',childName:profile.child_name||'',parentSession:token,expiresAt});
    }
    if (request.method === 'POST' && url.pathname === '/lab/upload-form') {
      return uploadMediaForm(request, env);
    }
    const auth = await authorized(request, env);
    if (!auth) return json({ ok: false, message: 'Unauthorized' }, 401);

    if (auth.preview) {
      const path = url.pathname;
      const allowed = request.method === 'GET' && (
        path === '/lab/profile' || path === '/lab/parent-unread' ||
        path === '/lab/report-current' || path === '/lab/report-history' ||
        path === '/lab/threads/' + auth.phone10
      );
      if (!allowed) return json({ok:false,message:'Предварительный просмотр доступен только для чтения.'},403);
    }

    if (request.method === 'POST' && url.pathname === '/lab/parent-session/renew') {
      if (auth.role !== 'parent') return json({ ok: false, message: 'Forbidden' }, 403);
      if (!env.LAB_D1_SESSION_SECRET) return json({ ok: false, message: 'Сервис авторизации временно недоступен.' }, 503);
      const session = await issueParentSession(auth.phone10, env.LAB_D1_SESSION_SECRET, env);
      return json({ ok: true, parentSession: session.token, expiresAt: session.expiresAt });
    }

    if (request.method === 'POST' && url.pathname === '/lab/parent-passkeys/registration/options') {
      const { parentPasskeyRegistrationOptions } = await import('./parent-passkeys.mjs');
      return parentPasskeyRegistrationOptions(request, env, auth);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-passkeys/status') {
      if (auth.role !== 'parent') return json({ ok: false, message: 'Forbidden' }, 403);
      const account = await env.CHAT_DB.prepare('SELECT user_handle FROM parent_auth_profiles WHERE phone10=?').bind(auth.phone10).first();
      if (!account) return json({ ok: false, message: 'Профиль уже не активен.' }, 410);
      const credential = await env.CHAT_DB.prepare('SELECT 1 AS present FROM parent_passkeys WHERE user_handle=? AND revoked_at IS NULL LIMIT 1').bind(account.user_handle).first();
      return json({ ok: true, hasPasskey: !!credential });
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-passkeys/registration/verify') {
      const { parentPasskeyRegistrationVerify } = await import('./parent-passkeys.mjs');
      return parentPasskeyRegistrationVerify(request, env, auth, { issueParentSession });
    }

    if (request.method === 'GET' && url.pathname === '/lab/parent-access/requests') {
      if (auth.role !== 'educator') return json({ ok: false, message: 'Forbidden' }, 403);
      return listParentAccessRequests(env);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-access/decision') {
      if (auth.role !== 'educator') return json({ ok: false, message: 'Forbidden' }, 403);
      return decideParentAccessRequest(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/lab/report-inactivity') {
      if (auth.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
      return getReportInactivityReminder(env);
    }
    if (request.method === 'POST' && url.pathname === '/lab/report-inactivity/ack') {
      if (auth.role !== 'educator') return json({ ok:false, message:'Forbidden' }, 403);
      return acknowledgeReportInactivity(request, env);
    }

    if (auth.role === 'parent') {
      const activeProfile = await env.CHAT_DB.prepare(
        'SELECT phone10 FROM chat_profiles WHERE phone10 = ?'
      ).bind(auth.phone10).first();

      if (!activeProfile) {
        return json({
          ok: false,
          code: 'CHAT_CLOSED',
          message: 'Chat is closed'
        }, 410);
      }
    }

    const guardedPhone = url.pathname.match(/^\/lab\/(?:threads|read|unread|read-parent|pin)\/([^/]+)/)?.[1] || '';
    if (auth.role === 'parent' && guardedPhone && phone10(guardedPhone) !== auth.phone10) return json({ ok: false, message: 'Forbidden' }, 403);
    if (auth.role === 'parent' && request.method === 'POST' && url.pathname === '/lab/messages') {
      const cloned = request.clone();
      const payload = await body(cloned);
      if (phone10(payload && payload.phone) !== auth.phone10 || String(payload && payload.side) !== 'parent') return json({ ok: false, message: 'Forbidden' }, 403);
    }
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true, service: 'medsi-chat-worker' });
    if (request.method === 'POST' && url.pathname === '/lab/upload') {
      if (!['parent', 'educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return uploadMedia(request, env, auth);
    }
    if (request.method === 'POST' && url.pathname === '/lab/report-submit') {
      return enqueueReportSubmission(request, env, auth, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/lab/report-submit/status') {
      return getReportSubmissionQueueStatus(env, auth, url.searchParams.get('submissionId'));
    }
    if (request.method === 'GET' && url.pathname === '/lab/report-failures') {
      return listRecentReportFailures(env, auth);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-delete') {
      return enqueueParentDeletion(request, env, auth, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/lab/parent-delete/status') {
      return getParentDeletionStatus(env, auth, url.searchParams.get('operationId'));
    }
    if (request.method === 'GET' && url.pathname === '/lab/parent-delete/pending') {
      return listParentDeletionJobs(env, auth);
    }
    if (request.method === 'POST' && url.pathname === '/lab/parent-delete/retry') {
      return retryParentDeletion(request, env, auth, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/lab/profile') {
      return getOwnProfile(env, auth);
    }
    if (request.method === 'GET' && url.pathname === '/lab/parent-unread') {
      const chat = await getParentUnreadState(env, auth);
      const report = await getParentReportUnread(env, auth);
      const a = await chat.json(), b = await report.json();
      return json({ ok:true, hasUnread:!!a.hasUnread, reportUnread:b.reportUnread || {} });
    }
    if (request.method === 'POST' && url.pathname === '/lab/report-read') return markParentReportRead(request, env, auth);
    if (request.method === 'POST' && url.pathname === '/lab/bot-log') {
      return json({ ok: false }, 410);
    }
    if (request.method === 'POST' && url.pathname === '/lab/messages') {
      if (!['parent', 'educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return addMessage(request, env, auth, ctx);
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/lab/parents') {
      if (auth.role !== 'educator') return json({ ok: false, message: 'Forbidden' }, 403);
      return listParents(env);
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/lab/chats') {
      if (!['educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return listChats(env, url.searchParams.get('bucket') || 'all');
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/lab/report-history') {
      return getParentReportHistory(env, auth);
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/lab/report-current') {
      return getParentCurrentReports(env, auth);
    }
    if ((request.method === 'GET' || request.method === 'POST') && url.pathname.startsWith('/lab/threads/')) return getThread(env, url.pathname.slice('/lab/threads/'.length), url.searchParams.get('before'), url.searchParams.get('limit'));
    if (request.method === 'POST' && url.pathname.startsWith('/lab/read/')) {
      if (!['educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return markEducatorRead(env, url.pathname.slice('/lab/read/'.length));
    }
    if (request.method === 'POST' && url.pathname.startsWith('/lab/unread/')) {
      if (!['educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return markEducatorUnread(env, url.pathname.slice('/lab/unread/'.length));
    }
    if (request.method === 'POST' && url.pathname.startsWith('/lab/read-parent/')) {
      if (!['parent', 'educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return markParentRead(env, url.pathname.slice('/lab/read-parent/'.length));
    }
    if (request.method === 'POST' && url.pathname.startsWith('/lab/pin/')) {
      if (!['educator'].includes(auth.role)) return json({ ok: false, message: 'Forbidden' }, 403);
      return setPin(request, env, url.pathname.slice('/lab/pin/'.length));
    }
    if (request.method === 'POST' && url.pathname.startsWith('/lab/reaction/')) return mutateMessage(request, env, 'reaction', url.pathname.slice('/lab/reaction/'.length), auth);
    if (request.method === 'POST' && url.pathname.startsWith('/lab/edit/')) return mutateMessage(request, env, 'edit', url.pathname.slice('/lab/edit/'.length), auth);
    if (request.method === 'POST' && url.pathname.startsWith('/lab/delete/')) return mutateMessage(request, env, 'delete', url.pathname.slice('/lab/delete/'.length), auth);
    return json({ ok: false, message: 'Not found' }, 404);
  }
};
