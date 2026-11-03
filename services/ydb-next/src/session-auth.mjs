import { createHmac, timingSafeEqual } from 'node:crypto';

const ONE_DAY = 86400000;
const PHONE = /^\d{10}$/;
function hmac(secret, value) {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}
function secureEqual(a,b) {
  const aBytes = Buffer.from(String(a || ''),'utf8');
  const bBytes = Buffer.from(String(b || ''),'utf8');
  return aBytes.length === bBytes.length && timingSafeEqual(aBytes,bBytes);
}
function encode(obj) {
  return Buffer.from(JSON.stringify(obj),'utf8').toString('base64url');
}
function decode(raw) {
  const content = Buffer.from(raw,'base64url').toString('utf8');
  if (content.length > 4096) throw new Error('Session payload is too large.');
  return JSON.parse(content);
}
function numberCheck(n) {
  return Number.isFinite(n) && n > 0;
}

// Cloudflare D1 tokens and educator-derived worker tokens are already
// payloadBase64url.HMAC_SHA256(payloadBase64url, LAB_D1_SESSION_SECRET).
export function signCompatibleWorkerSession(claims, secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('Worker session signing key is not configured.');
  }
  const payload=encode(claims);
  return payload + '.' + hmac(secret,payload);
}

export function verifyCompatibleWorkerSession(token, secret, now=Date.now()) {
  if (!secret || typeof token !== 'string' || token.length > 8192) return null;
  const parts=token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!secureEqual(hmac(secret,parts[0]),parts[1])) return null;
  try {
    const claims=decode(parts[0]);
    if (!claims || !numberCheck(claims.exp) || Number(claims.exp) <= now) return null;
    if (!['parent','educator'].includes(claims.role)) return null;
    if (claims.role === 'parent' && !PHONE.test(String(claims.phone10 || ''))) return null;
    return claims;
  } catch (_) {
    return null;
  }
}

export function signCompatibleTutorSession(login, password, version, now=Date.now()) {
  if (!login || !password || !version) throw new Error('Tutor credentials are not configured.');
  const payload=encode({version,issuedAt:now});
  return 'tutor1.' + payload + '.' + hmac(login + ':' + password,payload);
}

export function verifyCompatibleTutorSession(token, login, password, version) {
  const parts=String(token || '').split('.');
  if (!login || !password || !version || parts.length!==3 || parts[0]!=='tutor1') return false;
  if (!secureEqual(parts[2],hmac(login + ':' + password,parts[1]))) return false;
  try {
    const payload=decode(parts[1]);
    return payload.version===version && numberCheck(payload.issuedAt);
  } catch (_) {return false;}
}

export function createSessionService({sql,secret,login,password,tutorVersion,now=()=>Date.now()}) {
  if (!sql || typeof sql.begin !== 'function') throw new Error('YDB client required.');
  if (String(secret || '').length < 32 || !login || !password || !tutorVersion) {
    throw new Error('Session secrets are not configured.');
  }
  const loadParent = async (phone10) => {
    const rows=await sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>{
      const [authProfiles]=await tx`SELECT generation_id, created_at
        FROM parent_auth_profiles WHERE phone10 = ${phone10}`;
      const [profiles]=await tx`SELECT phone10, admission_id FROM parent_profiles
        WHERE phone10 = ${phone10}`;
      return {auth:authProfiles[0], profile:profiles[0]};
    });
    return rows?.auth && rows?.profile ? rows.auth : null;
  };
  const verifyWorker = async token => {
    const claims=verifyCompatibleWorkerSession(token,secret,now());
    if (!claims) return null;
    if (claims.role === 'parent') {
      const profile = await loadParent(claims.phone10);
      if (!profile) return null;
      if (claims.authGeneration) {
        if (claims.authGeneration !== profile.generation_id) return null;
      } else {
        // Preserve Cloudflare's legacy token issuance protection.
        const createdAt=Number(profile.created_at || 0);
        if (createdAt > 0 && createdAt > Number(claims.exp) - 30*ONE_DAY) return null;
      }
    }
    return claims;
  };
  const issueParent = async (phone10, expiry=now()+365*ONE_DAY) => {
    if (!PHONE.test(phone10)) throw new Error('Invalid parent phone.');
    const profile=await loadParent(phone10);
    if (!profile) throw new Error('Parent profile is missing.');
    if (!numberCheck(expiry) || expiry<=now()) throw new Error('Invalid session expiry.');
    const claims={role:'parent',phone10,exp:expiry,authGeneration:profile.generation_id,version:'cf-parent-v2'};
    return { token:signCompatibleWorkerSession(claims,secret),expiresAt:expiry };
  };
  const issueEducator = () => {
    const expiry=now()+5*365*ONE_DAY;
    return {token:signCompatibleWorkerSession({role:'educator',phone10:'',exp:expiry},secret),expiresAt:expiry};
  };
  const verifyTutor = token => verifyCompatibleTutorSession(token,login,password,tutorVersion);
  const loginTutor = (enteredLogin,enteredPassword) => {
    if (!secureEqual(enteredLogin,login) || !secureEqual(enteredPassword,password)) {
      return {ok:false,message:'Неверный логин или пароль.'};
    }
    return {ok:true,token:signCompatibleTutorSession(login,password,tutorVersion,now()),
      d1Session:issueEducator()};
  };
  const renewTutor = token => {
    if (!verifyTutor(token)) return {ok:false};
    return {ok:true,d1Session:issueEducator()};
  };
  return {verifyWorker,issueParent,issueEducator,verifyTutor,loginTutor,renewTutor,loadParent};
}
