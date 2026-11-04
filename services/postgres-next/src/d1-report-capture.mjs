import {generateManifest} from '../app/migration-audit.mjs';

export const D1_CURRENT_REPORTS_QUERY=`SELECT phone10,kind,text,version,read_version,updated_at,
  profile_generation,child_admission_id,revision,publication_id FROM report_current`;
export const D1_REPORT_HISTORY_QUERY=`SELECT phone10,kind,report_date,text,captured_at,
  profile_generation,child_admission_id,revision,publication_id FROM report_snapshots`;

const kinds=new Set(['morning','evening','psychology']);
const text=value=>typeof value==='string'&&!value.includes('\0');
const id=value=>text(value)&&value.length>0&&value.trim()===value;
const invalid=()=>{throw new Error('Invalid or ambiguous report capture.');};
function integer(value){
  if((typeof value!=='string'&&typeof value!=='number')||
     !/^(0|[1-9][0-9]{0,15})$/.test(String(value))||!Number.isSafeInteger(Number(value)))invalid();
  return String(value);
}
function date(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))invalid();
  const parsed=new Date(value+'T00:00:00Z');
  if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==value)invalid();
  return value;
}

// Current reports require the current profile. Historical records may carry
// an older admission only if its exact phone/generation/admission was reviewed.
export function normalizeD1Reports(current,history,profiles,historicalLinks=[]){
  if(![current,history,profiles,historicalLinks].every(Array.isArray))invalid();
  const active=new Map(),authorizedHistory=new Set();
  for(const link of [...profiles,...historicalLinks]){
    if(!link||typeof link.phone10!=='string'||!/^\d{10}$/.test(link.phone10)||
       !id(link.profile_generation)||!id(link.admission_id))invalid();
    authorizedHistory.add(JSON.stringify([link.phone10,link.profile_generation,link.admission_id]));
  }
  for(const profile of profiles){
    if(active.has(profile.phone10))invalid();
    active.set(profile.phone10,profile);
  }
  function base(row,historical){
    if(!row||!active.has(row.phone10)||!kinds.has(row.kind)||!text(row.text)||
       !text(row.publication_id)||!id(row.profile_generation)||!id(row.child_admission_id))invalid();
    const profile=active.get(row.phone10);
    if(historical ? !authorizedHistory.has(JSON.stringify([row.phone10,row.profile_generation,row.child_admission_id]))
      : profile.profile_generation!==row.profile_generation||profile.admission_id!==row.child_admission_id)invalid();
    return {phone10:row.phone10,kind:row.kind,admission_id:row.child_admission_id,
      publication_id:row.publication_id,revision:integer(row.revision),text:row.text};
  }
  const seenCurrent=new Set(),seenHistory=new Set();
  return {
    parent_current_reports:current.map(row=>{
      const fields=base(row,false),key=JSON.stringify([fields.phone10,fields.kind]);
      if(seenCurrent.has(key)||!text(row.version)||!text(row.read_version))invalid();
      seenCurrent.add(key);
      return {...fields,version:row.version,read_version:row.read_version,updated_at:integer(row.updated_at)};
    }),
    parent_report_history:history.map(row=>{
      const fields=base(row,true),report_date=date(row.report_date);
      const key=JSON.stringify([fields.phone10,fields.kind,report_date]);
      if(seenHistory.has(key))invalid();
      seenHistory.add(key);
      return {...fields,report_date,captured_at:integer(row.captured_at)};
    })
  };
}

export function captureD1ReportManifests(current,history,profiles,historicalLinks,hmacKey){
  return Object.entries(normalizeD1Reports(current,history,profiles,historicalLinks))
    .map(([stream,rows])=>generateManifest(stream,rows,hmacKey));
}

export async function importD1Reports(sql,current,history,profiles,historicalLinks,
  {hmacKey,expectedManifests,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true||freezeConfirmed!==true)throw new Error('Explicit frozen report import approval required.');
  const streams=Object.entries(normalizeD1Reports(current,history,profiles,historicalLinks));
  const expected=streams.map(([name,rows])=>generateManifest(name,rows,hmacKey));
  if(!Array.isArray(expectedManifests)||expectedManifests.length!==expected.length||
     expected.some(item=>!expectedManifests.some(manifest=>manifest?.stream===item.stream &&
       manifest.digest===item.digest&&manifest.count===item.count&&manifest.duplicateRows===item.duplicateRows))){
    throw new Error('Report manifests mismatch.');
  }
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.admissions, public.parent_profiles IN SHARE MODE`;
    await tx`LOCK TABLE public.parent_current_reports, public.parent_report_history IN SHARE ROW EXCLUSIVE MODE`;
    const [storedProfiles]=await tx`SELECT phone10,profile_generation,admission_id FROM public.parent_profiles`;
    const [admissions]=await tx`SELECT admission_id,status FROM public.admissions`;
    const storedByPhone=new Map(storedProfiles.map(row=>[row.phone10,row]));
    const statusById=new Map(admissions.map(row=>[row.admission_id,row.status]));
    for(const profile of profiles){
      const stored=storedByPhone.get(profile.phone10);
      if(stored?.admission_id!==profile.admission_id||
         stored.profile_generation!==profile.profile_generation||
         statusById.get(profile.admission_id)!=='active'){
        throw new Error('PostgreSQL profiles do not match the approved report linkage.');
      }
    }
    if(streams[1][1].some(row=>!statusById.has(row.admission_id))){
      throw new Error('PostgreSQL roster is missing an approved historical admission.');
    }
    const counts={};
    for(const [[name,rows],manifest] of streams.map((stream,index)=>[stream,expected[index]])){
      const table=tx.identifier(name);
      const [existing]=await tx`SELECT * FROM public.${table}`;
      if(!existing.length){
        for(const row of rows){
          const columns=Object.keys(row);
          const parts=['INSERT INTO public.',' (',...columns.slice(1).map(()=>', '),') VALUES (',
            ...columns.slice(1).map(()=>', '),')'];
          await tx(parts,table,...columns.map(column=>tx.identifier(column)),...Object.values(row));
        }
      }
      const [stored]=await tx`SELECT * FROM public.${table}`;
      if(generateManifest(name,stored,hmacKey).digest!==manifest.digest){
        throw new Error('PostgreSQL report stream differs from the baseline.');
      }
      counts[name]=stored.length;
    }
    return counts;
  });
}
