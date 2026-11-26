import {fullName} from './doctors-roster.mjs';

// Never use edit-distance surname guesses or first-name-only matching.
const WORD=/^\p{L}{2,}(?:-\p{L}{2,})*$/u;
export function doctorNameParts(value){
  const cleaned=fullName(value).replace(/[\u2010\u2011\u2013]/gu,'-')
    .replace(/(?:\s*[,;]\s*|\s+|\s*\(\s*)\d{1,2}\s*(?:год(?:а)?|лет|л\.?)?\s*\)?$/u,'')
    .replace(/(?:\s*[,;]\s*|\s+|\s*\(\s*)\d{1,2}[./-]\d{1,2}[./-]\d{4}\s*\)?$/u,'')
    .replace(/\s+(?:январь|февраль|март|апрель|май|июнь|июль|август|сентябрь|октябрь|ноябрь|декабрь)(?:\s+\d{4})?$/u,'')
    .replace(/[,;]+/gu,' ').trim().replace(/\s+/gu,' ');
  const words=cleaned.split(' ');
  return (words.length>=2&&words.length<=4)&&words.every(word=>WORD.test(word))?words:null;
}

// Existing Medsi name groups are the authoritative alias dictionary. Do not
// transitively merge overlapping groups; an ambiguous alias stays literal.
export function createDoctorNameMatcher(items=[]){
  const groups=new Map();
  for(const item of items){
    const key=fullName(item.baseKey||item.preferredName);
    if(!WORD.test(key))continue;
    for(const word of [item.preferredName,...(Array.isArray(item.variants)?item.variants:[]),key]){
      const value=fullName(word);
      if(!WORD.test(value))continue;
      if(!groups.has(value))groups.set(value,new Set());
      groups.get(value).add(key);
    }
  }
  const equivalent=(a,b)=>a===b ||
    (groups.get(a)?.size===1 && groups.get(b)?.size===1 &&
      [...groups.get(a)][0]===[...groups.get(b)][0]);
  function matches(value,parts){
    const words=doctorNameParts(value);
    if(!parts||!words)return false;
    if(parts.length===4||words.length===4)return parts.join(' ')===words.join(' ');
    if(parts[2]&&words[2]&&parts[2]!==words[2])return false;
    // Require one literal matching surname, and allow the given-name alias.
    return [[words[0],words[1]],[words[1],words[0]]].some(([a,b])=>
      (a===parts[0]&&equivalent(b,parts[1])) ||
      (b===parts[1]&&equivalent(a,parts[0])));
  }
  return {matches};
}

export function resolveDoctorFolder(patient,patients,folders,matcher){
  const parts=doctorNameParts(patient.childName);
  if(!parts)return {folder:null,ambiguous:false};
  const candidates=folders.filter(folder=>matcher.matches(folder.name,parts));
  const duplicate=patients.some(other=>other.id!==patient.id && matcher.matches(other.childName,parts));
  const shared=candidates.some(folder=>patients.some(other=>other.id!==patient.id &&
    matcher.matches(folder.name,doctorNameParts(other.childName))));
  const ambiguous=duplicate||shared||candidates.length>1;
  return {folder:!ambiguous&&candidates.length===1?candidates[0]:null,ambiguous};
}
