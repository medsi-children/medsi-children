// Match only existing active admissions. A first name mentioned in a raw
// report cannot by itself authorize parent access to medical information.
const normalized=value=>String(value||'').trim().normalize('NFC')
  .replace(/\s+/g,' ').toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const fullName=value=>{
  const parts=normalized(value).split(' ');
  return parts.length===2&&parts.every(p=>/^[\p{L}-]{2,80}$/u.test(p))
    ?{first:parts[0],surname:parts[1]}:null;
};
function variantsIndex(rows){
  const groups=[];
  for(const row of rows||[]){
    const preferred=normalized(row.preferred_name||row.preferredName);
    if(!preferred)continue;
    let variants=row.variants_json??row.variants??[];
    if(typeof variants==='string'){
      try{variants=JSON.parse(variants)}catch{variants=variants.split(',')}
    }
    if(!Array.isArray(variants))variants=[];
    groups.push({preferred,forms:new Set([preferred,...variants.map(normalized)].filter(Boolean))});
  }
  return name=>{
    const key=normalized(name);
    if(!key)return null;
    const matches=groups.filter(group=>group.forms.has(key));
    // An alias belonging to more than one group is unsafe to resolve.
    return matches.length===1?matches[0].preferred:matches.length===0?key:null;
  };
}
export function findUniqueActiveAdmissionForParent({
  childName,children=[],admissions=[],nameVariants=[]
}={}){
  const entered=fullName(childName);
  if(!entered)return null;
  const canonical=variantsIndex(nameVariants),first=canonical(entered.first);
  if(!first)return null;
  const byId=new Map(children.map(child=>[String(child.child_id),child]));
  const matches=[];
  for(const admission of admissions){
    if(admission.status!=='active')continue;
    const child=byId.get(String(admission.child_id));
    if(!child)continue;
    if(normalized(child.surname)!==entered.surname)continue;
    if(canonical(child.registered_first_name)!==first)continue;
    matches.push({childId:String(child.child_id),admissionId:String(admission.admission_id)});
  }
  return matches.length===1?matches[0]:null;
}
// Repair only genuinely unlinked authenticated profiles, without changing
// historical clinical associations or creating new hospital records.
export async function reconcileUnlinkedRegisteredParents(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL client unavailable.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    const [[profiles],[authenticated]]=await Promise.all([
      tx`SELECT phone10,child_name,child_id,admission_id,profile_generation FROM parent_profiles`,
      tx`SELECT phone10 FROM parent_auth_profiles`
    ]);
    const authSet=new Set(authenticated.map(row=>String(row.phone10)));
    const waiting=profiles.filter(p=>authSet.has(String(p.phone10))&&
      !String(p.child_id||'').trim()&&!String(p.admission_id||'').trim()&&
      String(p.child_name||'').trim());
    if(!waiting.length)return {ok:true,linked:0,review:0};
    const [[children],[admissions],[nameVariants]]=await Promise.all([
      tx`SELECT child_id,registered_first_name,surname FROM children`,
      tx`SELECT admission_id,child_id,status FROM admissions`,
      tx`SELECT base_key,preferred_name,variants_json FROM name_variants`
    ]);
    let linked=0,review=0;
    for(const profile of waiting){
      const match=findUniqueActiveAdmissionForParent({
        childName:profile.child_name,children,admissions,nameVariants
      });
      if(!match){review++;continue}
      const [rows]=await tx`UPDATE parent_profiles
        SET child_id=${match.childId},admission_id=${match.admissionId},updated_at=${BigInt(now())}
        WHERE phone10=${String(profile.phone10)}
          AND COALESCE(child_id,${''})=${''}
          AND COALESCE(admission_id,${''})=${''}
        RETURNING phone10`;
      if(!rows.length)continue;
      linked++;
      if(profile.profile_generation){
        await tx`UPDATE parent_registration_attempts
          SET child_id=${match.childId},admission_id=${match.admissionId},updated_at=${BigInt(now())}
          WHERE attempt_id=${String(profile.profile_generation)}
            AND phone10=${String(profile.phone10)}
            AND status=${'COMPLETED'}`;
      }
    }
    return {ok:true,linked,review};
  });
}
