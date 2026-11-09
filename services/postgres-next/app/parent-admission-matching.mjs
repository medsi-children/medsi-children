import {createAdmissionFromStaffReport,recentStaffSource,staffSourceContradictsExistingChild} from './report-observed-admission.mjs';
// Match only existing active admissions. The variants dictionary identifies
// nicknames, and an unambiguous active first name is enough even if a parent
// supplies no surname. Contradictory suffixes and namesakes always block it.
const normalized=value=>String(value||'').trim().normalize('NFC')
  .replace(/\s+/g,' ').toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const enteredName=value=>{
  const parts=normalized(value).split(' ').filter(Boolean);
  if(!parts.length||parts.length>2||
    !parts.every((p,i)=>i===0?/^[\p{L}-]{2,80}$/u.test(p):/^[\p{L}-]{1,80}\.?$/u.test(p)))return null;
  return {first:parts[0],surnamePrefix:(parts[1]||'').replace(/\.$/,'')};
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
export function canonicalRegisteredName(value,variants) {
  return variantsIndex(variants)(value);
}
export function parseRegisteredChildName(value){
  return enteredName(value);
}
// Admission-free identity resolver. Candidates are current, registered
// parent profiles only. An orphan child row can never become a candidate.
// This is a pure migration primitive; existing production callers stay
// unchanged until report ownership and read paths are migrated together.
export function findUniqueRegisteredChildForParent({
  childName,profiles=[],nameVariants=[]
}={}){
  const entered=enteredName(childName);
  if(!entered)return null;
  const canonical=variantsIndex(nameVariants),first=canonical(entered.first);
  if(!first)return null;
  const candidates=new Map();
  for(const profile of profiles){
    const id=String(profile.child_id||'').trim();
    if(!id)continue;
    const known=enteredName(profile.child_name);
    if(!known||canonical(known.first)!==first)continue;
    const surname=known.surnamePrefix;
    const prior=candidates.get(id);
    if(prior&&prior.surname!==surname)return null;
    candidates.set(id,{childId:id,surname});
  }
  const matches=[...candidates.values()].filter(candidate=>
    !entered.surnamePrefix||
    (candidate.surname&&candidate.surname.startsWith(entered.surnamePrefix)));
  // Unknown surname cannot justify a positive surname-prefix match.
  return matches.length===1?{childId:matches[0].childId}:null;
}
export function findUniqueActiveAdmissionForParent({
  childName,children=[],admissions=[],nameVariants=[]
}={}){
  const entered=enteredName(childName);
  if(!entered)return null;
  const canonical=variantsIndex(nameVariants),first=canonical(entered.first);
  if(!first)return null;
  const byId=new Map(children.map(child=>[String(child.child_id),child]));
  // A first-name-only parent registration maps to the ONE active admission
  // in that canonical alias group. The absence of a surname is not a blocker.
  const candidates=admissions.filter(a=>a.status==='active').flatMap(admission=>{
    const child=byId.get(String(admission.child_id));
    return child&&canonical(child.registered_first_name)===first
      ?[{childId:String(child.child_id),admissionId:String(admission.admission_id),
          surname:normalized(child.surname)}]:[];
  });
  // If the parent gave a surname or initial, it must agree; in particular,
  // never ignore contradictory data just because this is the only namesake.
  const matches=entered.surnamePrefix
    ?candidates.filter(c=>c.surname.startsWith(entered.surnamePrefix)||(!c.surname&&candidates.length===1))
    :candidates;
  return matches.length===1
    ?{childId:matches[0].childId,admissionId:matches[0].admissionId}:null;
}
// Repair only genuinely unlinked authenticated profiles, without changing
// historical clinical associations or creating new hospital records.
export async function reconcileUnlinkedRegisteredParents(sql,{now=()=>Date.now(),phone10=''}={}){
  if(!sql?.begin)throw new Error('PostgreSQL client unavailable.');
  if(phone10&&!/^\d{10}$/.test(String(phone10)))throw new Error('Invalid parent phone.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    const [[profiles],[authenticated]]=await Promise.all([
      phone10
        ?tx`SELECT phone10,child_name,child_id,admission_id,profile_generation FROM parent_profiles WHERE phone10=${phone10}`
        :tx`SELECT phone10,child_name,child_id,admission_id,profile_generation FROM parent_profiles`,
      phone10
        ?tx`SELECT phone10 FROM parent_auth_profiles WHERE phone10=${phone10}`
        :tx`SELECT phone10 FROM parent_auth_profiles`
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
    let linked=0,review=0,reports=null;
    for(const profile of waiting){
      let match=findUniqueActiveAdmissionForParent({
        childName:profile.child_name,children,admissions,nameVariants
      });
      const entered=enteredName(profile.child_name);
      const matchedChild=match&&children.find(row=>String(row.child_id)===match.childId);
      if(match&&(!entered?.surnamePrefix||!normalized(matchedChild?.surname))){
        if(!reports)reports=await recentStaffSource(tx,now());
        const child=children.find(row=>String(row.child_id)===match.childId);
        if(staffSourceContradictsExistingChild({
          childName:entered?.first,surname:child?.surname||entered?.surnamePrefix,nameVariants,reports
        }))match=null;
      }
      if(!match){
        if(!reports)reports=await recentStaffSource(tx,now());
        match=await createAdmissionFromStaffReport(tx,{
          childName:profile.child_name,children,admissions,nameVariants,reports,now:now()
        });
        if(match){
          children.push({child_id:match.childId,registered_first_name:match.firstName,
            surname:match.surname});
          admissions.push({admission_id:match.admissionId,child_id:match.childId,status:'active'});
        }
      }
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
