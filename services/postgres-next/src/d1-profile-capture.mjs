import {generateManifest} from '../app/migration-audit.mjs';

export const D1_PARENT_PROFILES_QUERY=`SELECT phone10,parent_name,child_name,relationship,
  child_genitive,profile_generation,child_admission_id FROM chat_profiles ORDER BY phone10`;

const phone=value=>typeof value==='string'&&/^\d{10}$/.test(value);
const text=value=>typeof value==='string'&&!value.includes('\0');
const id=value=>text(value)&&value.length>0&&value.trim()===value;
const invalid=()=>{throw new Error('Invalid or ambiguous parent profile linkage.');};

// Linkage comes from an independently reviewed roster capture. Do not join by
// child name: different children and admissions can share the same display name.
export function normalizeD1ParentProfiles(profiles,links,admissions){
  if(![profiles,links,admissions].every(Array.isArray))invalid();
  const byAdmission=new Map(),byPhone=new Map();
  for(const row of admissions){
    if(!row||!id(row.admission_id)||!id(row.child_id)||byAdmission.has(row.admission_id))invalid();
    byAdmission.set(row.admission_id,row);
  }
  for(const row of links){
    if(!row||!phone(row.phone10)||!id(row.profile_generation)||!id(row.admission_id)||
       byPhone.has(row.phone10))invalid();
    byPhone.set(row.phone10,row);
  }
  const seen=new Set();
  const normalized=profiles.map(row=>{
    if(!row||!phone(row.phone10)||seen.has(row.phone10)||
       !['parent_name','child_name','relationship','child_genitive','child_admission_id']
         .every(field=>text(row[field]))||!id(row.profile_generation))invalid();
    seen.add(row.phone10);
    const link=byPhone.get(row.phone10);
    const admission=byAdmission.get(link?.admission_id);
    if(!link||link.profile_generation!==row.profile_generation||!admission||
       admission.status!=='active'||
       (row.child_admission_id!==''&&row.child_admission_id!==admission.admission_id))invalid();
    return {phone10:row.phone10,parent_name:row.parent_name,child_name:row.child_name,
      relationship:row.relationship,child_id:admission.child_id,admission_id:admission.admission_id,
      profile_generation:row.profile_generation,child_genitive:row.child_genitive,
      created_at:null,updated_at:null};
  });
  if(seen.size!==byPhone.size)invalid();
  return normalized;
}

export function captureD1ParentProfileManifest(profiles,links,admissions,hmacKey){
  return generateManifest('parent_profiles',normalizeD1ParentProfiles(profiles,links,admissions),hmacKey);
}

export async function importD1ParentProfiles(sql,profiles,links,admissions,
  {hmacKey,expectedManifest,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true||freezeConfirmed!==true)throw new Error('Explicit frozen profile import approval required.');
  const rows=normalizeD1ParentProfiles(profiles,links,admissions);
  const expected=generateManifest('parent_profiles',rows,hmacKey);
  if(expectedManifest?.stream!==expected.stream||expectedManifest.digest!==expected.digest||
     expectedManifest.count!==expected.count||expectedManifest.duplicateRows!==expected.duplicateRows){
    throw new Error('Parent profile manifest mismatch.');
  }
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.children, public.admissions IN SHARE MODE`;
    await tx`LOCK TABLE public.parent_profiles IN SHARE ROW EXCLUSIVE MODE`;
    const [existing]=await tx`SELECT * FROM public.parent_profiles`;
    const [roster]=await tx`SELECT a.admission_id,a.child_id FROM public.admissions a
      JOIN public.children c ON c.child_id=a.child_id WHERE a.status='active'`;
    const children=new Map(roster.map(row=>[row.admission_id,row.child_id]));
    if(rows.some(row=>children.get(row.admission_id)!==row.child_id)){
      throw new Error('PostgreSQL roster does not contain the approved admission linkage.');
    }
    if(!existing.length){
      for(const row of rows){
        await tx`INSERT INTO public.parent_profiles
          (phone10,parent_name,child_name,relationship,child_id,admission_id,profile_generation,
           child_genitive,created_at,updated_at)
          VALUES (${row.phone10},${row.parent_name},${row.child_name},${row.relationship},${row.child_id},
            ${row.admission_id},${row.profile_generation},${row.child_genitive},${row.created_at},${row.updated_at})`;
      }
    }
    const [stored]=await tx`SELECT * FROM public.parent_profiles`;
    if(generateManifest('parent_profiles',stored,hmacKey).digest!==expected.digest){
      throw new Error('PostgreSQL parent profiles differ from the baseline.');
    }
    return {count:stored.length,alreadyImported:existing.length>0};
  });
}
