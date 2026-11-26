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

  // Explicit operator-verified links are episode-scoped opaque IDs. Never infer
  // contact ownership from a similar or even identical name alone.
  const verifiedLinks=(()=>{
    if(!env.DOCTORS_VERIFIED_CONTACT_LINKS)return new Map();
    try{
      const entries=JSON.parse(env.DOCTORS_VERIFIED_CONTACT_LINKS);
      const valid=id=>typeof id==='string' && /^[A-Za-z0-9_-]{43}$/.test(id);
      if(!Array.isArray(entries) || entries.some(pair=>!Array.isArray(pair)||pair.length!==2||!pair.every(valid)))throw Error();
      if(new Set(entries.map(pair=>pair[0])).size!==entries.length || new Set(entries.map(pair=>pair[1])).size!==entries.length)throw Error();
      return new Map(entries);
    }catch{console.warn('MEDSI_DOCTORS_CONTACT_LINKS_INVALID');return new Map();}
  })();
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

  async function current(options) {
    if(!greenwood?.configured)return listBot();
    const rows = await greenwood.read(options);
    // The tab contains no verified contact identifier. Keep contacts in the
    // bot's phone directory and avoid assigning them to a possible namesake.
    const patients=rows.map(row=>({id:ref('greenwood:'+row.key),
      childName:row.childName,episode:row.episode,registry:true,registryDischarge:row.discharge||null,parents:[]}));
    if(!verifiedLinks.size)return patients;
    const botPatients=new Map((await listBot()).filter(p=>p.childId).map(p=>[p.id,p]));
    const namePair=value=>fullName(value).split(' ').slice(0,2).sort().join(' ');
    for(const patient of patients){
      const bot=botPatients.get(verifiedLinks.get(patient.id));
      if(patient.episode && bot && namePair(bot.childName)===namePair(patient.childName))patient.parents=bot.parents;
    }
    return patients;
  }

  async function list(options) {
    const patients=await current(options);
    return Promise.all(patients.map(async({childId,episode,registry,registryDischarge,...patient})=>{
      // A row without a verified start date is visible but cannot be assigned
      // contacts or a plan from a possibly different stay.
      if(registry && !episode)return {...patient,admission:null,discharge:null,editable:false};
      const clinical=await plans?.dates(patient.id);
      return {...patient,...clinical,admission:clinical?.admission || episode || null,discharge:clinical?.discharge || registryDischarge || null};
    }));
  }
  return {list,listBot,current};
}
