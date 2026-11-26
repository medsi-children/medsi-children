import {createHmac} from 'node:crypto';

export function normalizePhone(value) {
  return /^(?:[78])?(\d{10})$/.exec(String(value || '').replace(/\D/g, ''))?.[1] || '';
}

export function fullName(value) {
  return String(value || '').normalize('NFC').toLocaleLowerCase('ru')
    .replace(/ё/g,'е').trim().replace(/\s+/gu,' ');
}

export function createDoctorsRoster(sql, env, {greenwood, plans} = {}) {
  const excluded = new Set(String(env.DOCTORS_EXCLUDED_PHONES || '').split(/[,;\n]+/).map(normalizePhone).filter(Boolean));
  const ref = key => createHmac('sha256', env.NEXT_SESSION_SECRET).update('doctor-patient:'+key).digest('base64url');

  async function listBot() {
    const [rows] = await sql`SELECT p.phone10,p.parent_name,p.relationship,p.child_name,p.child_id,
      c.registered_first_name,c.surname
      FROM parent_profiles p JOIN parent_auth_profiles a ON a.phone10=p.phone10
      LEFT JOIN children c ON c.child_id=p.child_id ORDER BY p.phone10`;
    const patients = new Map();
    for (const row of rows) {
      const phone = normalizePhone(row.phone10);
      if (!phone || excluded.has(phone)) continue;
      const key = row.child_id ? 'child:'+row.child_id : 'pending:'+phone;
      if (!patients.has(key)) {
        const childName = [row.registered_first_name,row.surname].filter(Boolean).join(' ') || row.child_name;
        patients.set(key, {id:ref(key),childName,parents:[],childId:row.child_id || null});
      }
      patients.get(key).parents.push({phone:'+7'+phone,parentName:row.parent_name,relationship:row.relationship});
    }
    return [...patients.values()];
  }

  async function current({fresh=false}={}) {
    if(!greenwood?.configured)return listBot();
    const rows = await greenwood.read({fresh});
    // The tab contains no verified contact identifier. Keep contacts in the
    // bot's phone directory and avoid assigning them to a possible namesake.
    return rows.map(row=>({id:ref('greenwood:'+row.key),
      childName:row.childName,episode:row.episode,parents:[]}));
  }

  async function list() {
    const patients=await current();
    return Promise.all(patients.map(async({childId,episode,...patient})=>({...patient,...await plans?.dates(patient.id)})));
  }
  return {list,listBot,current};
}
