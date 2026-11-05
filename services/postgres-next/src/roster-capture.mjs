import {generateManifest} from '../app/migration-audit.mjs';

const invalid=()=>{throw new Error('Invalid or ambiguous roster capture.');};
const text=value=>typeof value==='string'&&!value.includes('\0');
const id=value=>text(value)&&value.length>0&&value.trim()===value;

function date(value){
  if(value===null)return null;
  if((typeof value!=='string'&&typeof value!=='number')||
     !/^[1-9]\d{0,15}$/.test(String(value))||!Number.isSafeInteger(Number(value)))invalid();
  return String(value);
}

// The operator supplies a reviewed identity crosswalk for the Sheets export.
// IDs and dates are preserved. Missing historical dates stay null.
export function normalizeRosterCapture(children,admissions){
  if(!Array.isArray(children)||!Array.isArray(admissions))invalid();
  const childIds=new Set(),admissionIds=new Set(),activeChildren=new Set();
  const normalizedChildren=children.map(row=>{
    if(!row||!id(row.child_id)||childIds.has(row.child_id)||
       !id(row.registered_first_name)||!text(row.surname))invalid();
    childIds.add(row.child_id);
    return {child_id:row.child_id,registered_first_name:row.registered_first_name,
      surname:row.surname,created_at:date(row.created_at)};
  });
  const normalizedAdmissions=admissions.map(row=>{
    if(!row||!id(row.admission_id)||admissionIds.has(row.admission_id)||
       !childIds.has(row.child_id)||!['active','discharged'].includes(row.status))invalid();
    const admitted=date(row.admitted_at),discharged=date(row.discharged_at);
    if(admitted!==null&&discharged!==null&&BigInt(admitted)>BigInt(discharged))invalid();
    if(row.status==='active'){
      if(discharged!==null||activeChildren.has(row.child_id))invalid();
      activeChildren.add(row.child_id);
    }
    admissionIds.add(row.admission_id);
    return {admission_id:row.admission_id,child_id:row.child_id,status:row.status,
      admitted_at:admitted,discharged_at:discharged};
  });
  return {children:normalizedChildren,admissions:normalizedAdmissions};
}

export function captureRosterManifests(children,admissions,hmacKey){
  return Object.entries(normalizeRosterCapture(children,admissions))
    .map(([name,rows])=>generateManifest(name,rows,hmacKey));
}

export async function importRosterCapture(sql,children,admissions,
  {hmacKey,expectedManifests,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true||freezeConfirmed!==true)throw new Error('Explicit frozen roster import approval required.');
  const roster=normalizeRosterCapture(children,admissions);
  const expected=Object.entries(roster).map(([name,rows])=>generateManifest(name,rows,hmacKey));
  if(!Array.isArray(expectedManifests)||expectedManifests.length!==expected.length||
     expected.some(item=>!expectedManifests.some(manifest=>manifest?.stream===item.stream &&
       manifest.digest===item.digest&&manifest.count===item.count&&manifest.duplicateRows===item.duplicateRows))){
    throw new Error('Roster manifests mismatch.');
  }
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.children, public.admissions IN SHARE ROW EXCLUSIVE MODE`;
    const [existingChildren]=await tx`SELECT * FROM public.children`;
    const [existingAdmissions]=await tx`SELECT * FROM public.admissions`;
    const alreadyImported=existingChildren.length>0||existingAdmissions.length>0;
    if(!alreadyImported){
      for(const row of roster.children){
        await tx`INSERT INTO public.children (child_id,registered_first_name,surname,created_at)
          VALUES (${row.child_id},${row.registered_first_name},${row.surname},${row.created_at})`;
      }
      for(const row of roster.admissions){
        await tx`INSERT INTO public.admissions (admission_id,child_id,status,admitted_at,discharged_at)
          VALUES (${row.admission_id},${row.child_id},${row.status},${row.admitted_at},${row.discharged_at})`;
      }
    }
    const [storedChildren]=await tx`SELECT * FROM public.children`;
    const [storedAdmissions]=await tx`SELECT * FROM public.admissions`;
    if(generateManifest('children',storedChildren,hmacKey).digest!==expected[0].digest ||
       generateManifest('admissions',storedAdmissions,hmacKey).digest!==expected[1].digest){
      throw new Error('PostgreSQL roster differs from the baseline.');
    }
    return {children:storedChildren.length,admissions:storedAdmissions.length,alreadyImported};
  });
}
