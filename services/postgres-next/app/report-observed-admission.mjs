import {randomUUID} from 'node:crypto';
import {canonicalRegisteredName,parseRegisteredChildName} from './parent-admission-matching.mjs';

const norm=value=>String(value||'').normalize('NFC').trim()
  .toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
// Only a staff-authored morning/evening CHILD BLOCK is a candidate.
// Incidental references in body paragraphs never qualify.
const HEADER=/^\s*([\p{L}-]{2,60})(?:\s+([\p{L}-]{1,80})\.?)?\s*[:—–]\s*\S/u;
const NAME_KEY=/^[\p{L}-]+$/u;
const canonical=(value,variants)=>canonicalRegisteredName(value,variants);
function reportMentions(reports,nameVariants,first,requested=''){
  const prefixes=new Set();
  let mentions=0;
  for(const report of reports||[]){
    if(report.kind!=='morning'&&report.kind!=='evening')continue;
    const text=String(report.normalized_text||report.raw_text||'');
    const blocks=[];
    for(const line of text.replace(/\r\n?/g,'\n').split('\n')){
      const m=HEADER.exec(line);
      if(!m||!NAME_KEY.test(m[1])||canonical(m[1],nameVariants)!==first)continue;
      const suffix=norm(m[2]).replace(/\.$/,'');
      blocks.push(suffix);
      prefixes.add(suffix);
      mentions++;
    }
    if(blocks.length>1){
      // Without a surname from the parent, two same-name children cannot
      // be distinguished. Even with a surname, identical staff initials
      // on two blocks are ambiguous.
      if(!requested||new Set(blocks).size<blocks.length||blocks.includes(''))return null;
    }
  }
  if(!mentions)return null;
  const explicit=[...prefixes].filter(Boolean);
  if(!requested){
    if(explicit.length>1)return null;
    return {prefix:explicit[0]||'',mentions};
  }
  const matching=explicit.filter(prefix=>
    requested.startsWith(prefix)||prefix.startsWith(requested));
  if(matching.length!==1&&explicit.length)return null;
  return {prefix:matching[0]||'',mentions};
}
// An active roster can still be incomplete when a new child first appears
// in staff notes. Never select an older namesake by first name alone if
// current reports show conflicting surname initials or duplicate blocks.
export function staffSourceContradictsExistingChild({
  childName,surname='',nameVariants=[],reports=[]
}={}){
  const entered=parseRegisteredChildName(childName);
  if(!entered||entered.surnamePrefix)return false;
  const first=canonical(entered.first,nameVariants);
  if(!first)return true;
  const prefixes=new Set();
  for(const report of reports){
    if(report.kind!=='morning'&&report.kind!=='evening')continue;
    let count=0;
    const text=String(report.normalized_text||report.raw_text||'');
    for(const line of text.replace(/\r\n?/g,'\n').split('\n')){
      const m=HEADER.exec(line);
      if(!m||canonical(m[1],nameVariants)!==first)continue;
      count++;
      if(m[2])prefixes.add(norm(m[2]).replace(/\.$/,''));
    }
    if(count>1)return true;
  }
  if(prefixes.size>1)return true;
  if(prefixes.size===1&&!norm(surname).startsWith([...prefixes][0]))return true;
  return false;
}
export function findUniqueRecentStaffMention({
  childName,children=[],admissions=[],nameVariants=[],reports=[]
}={}){
  const entered=parseRegisteredChildName(childName);
  if(!entered)return null;
  const first=canonical(entered.first,nameVariants);
  if(!first)return null;
  const byId=new Map(children.map(c=>[String(c.child_id),c]));
  const active=admissions.filter(a=>a.status==='active')
    .map(a=>byId.get(String(a.child_id))).filter(Boolean)
    .filter(c=>canonical(c.registered_first_name,nameVariants)===first);
  const requested=entered.surnamePrefix;
  // A new namesake may be reported by a *different* explicit surname
  // initial before they have an admission row. Never create them from a
  // bare name if an existing admission already shares that first name.
  if(active.length&&!requested)return null;
  if(active.some(c=>norm(c.surname).startsWith(requested)))return null;
  const evidence=reportMentions(reports,nameVariants,first,requested);
  if(!evidence)return null;
  if(active.length){
    if(!evidence.prefix||active.some(c=>norm(c.surname).startsWith(evidence.prefix)))
      return null;
  }
  // An initial is not a surname. Keep unknown family names blank rather
  // than writing a made-up legal surname into the hospital roster.
  const rawSurname=String(childName||'').trim().split(/\s+/)[1]||'';
  const surname=requested&&requested.length>=3
    ?rawSurname.charAt(0).toLocaleUpperCase('ru-RU')+rawSurname.slice(1):'';
  const titleFirst=first.charAt(0).toLocaleUpperCase('ru-RU')+first.slice(1);
  return {firstName:titleFirst,surname};
}
export async function createAdmissionFromStaffReport(tx,{
  childName,children,admissions,nameVariants,reports,now=Date.now()
}={}){
  const found=findUniqueRecentStaffMention({childName,children,admissions,nameVariants,reports});
  if(!found)return null;
  const childId='child_'+randomUUID().replace(/-/g,'');
  const admissionId='admission_'+randomUUID().replace(/-/g,'');
  await tx.upsert`INSERT INTO children (child_id,registered_first_name,surname,created_at)
    VALUES (${childId},${found.firstName},${found.surname},${BigInt(now)})`;
  await tx.upsert`INSERT INTO admissions (admission_id,child_id,status,admitted_at,discharged_at)
    VALUES (${admissionId},${childId},${'active'},${BigInt(now)},${null})`;
  return {childId,admissionId,firstName:found.firstName,surname:found.surname};
}
export async function recentStaffSource(tx,now=Date.now()){
  const cutoff=new Date(now-14*24*60*60*1000).toISOString().slice(0,10);
  const [rows]=await tx`SELECT kind,raw_text,normalized_text,report_date FROM raw_reports
    WHERE kind IN (${'morning'},${'evening'}) AND report_date>=${cutoff}
    ORDER BY submitted_at DESC LIMIT 60`;
  return rows;
}
