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

  let visibilitySchema;
  const prepareVisibility=()=>visibilitySchema||=(sql`CREATE TABLE IF NOT EXISTS doctor_hidden_patients (
    patient_id text PRIMARY KEY, hidden_at timestamptz NOT NULL DEFAULT now())`
    .catch(error=>{visibilitySchema=null;throw error;}));
  async function setHidden(id,hidden){
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(id)||typeof hidden!=='boolean')
      return {ok:false,status:400,message:'Не удалось изменить список.'};
    if(!greenwood?.configured||!(await current({fresh:true})).some(patient=>patient.id===id))
      return {ok:false,status:404,message:'Пациент больше не в реестре.'};
    await prepareVisibility();
    if(hidden)await sql`INSERT INTO doctor_hidden_patients(patient_id) VALUES(${id}) ON CONFLICT DO NOTHING`;
    else await sql`DELETE FROM doctor_hidden_patients WHERE patient_id=${id}`;
    return {ok:true};
  }

  async function list(options) {
    let patients=await current(options);
    const diskDisplay=await plans?.readDiskDisplay?.(patients);
    let hidden=new Set();
    if(greenwood?.configured&&patients.length){
      await prepareVisibility();
      const [rows]=await sql`SELECT patient_id FROM doctor_hidden_patients
        WHERE patient_id=ANY(${patients.map(patient=>patient.id)}::text[])`;
      hidden=new Set(rows.map(row=>row.patient_id));
      if(!options?.includeHidden)patients=patients.filter(patient=>!hidden.has(patient.id));
    }
    return Promise.all(patients.map(async({childId,episode,registry,registryDischarge,...details})=>{
      const patient={...details,...(registry?{hideable:true,hidden:hidden.has(details.id)}:{})};
      // A row without a verified start date is visible but cannot be assigned
      // contacts or a plan from a possibly different stay.
      if(registry && !episode)return {...patient,admission:null,discharge:null,editable:false};
      const clinical=await plans?.dates(patient.id,{episode,registry,registryDischarge},diskDisplay);
      return {...patient,...clinical,admission:clinical?.admission || episode || null,discharge:clinical?.discharge || registryDischarge || null};
    }));
  }
  return {list,listBot,current,setHidden};
}
