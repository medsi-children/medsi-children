// Educator-only display of published MORNING/EVENING source texts.
// The source and signed publication history are immutable; never infer owners
// from a currently shared first name. Use the exact publication's parent
// history and admission IDs as proof before expanding ambiguous initials.
const norm=value=>String(value||'').normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const comparable=value=>norm(value).replace(/\s+/g,' ').replace(/\s*[–—]\s*/g,' - ');
const family=value=>norm(value).replace(/[^а-яa-z]/g,'');
const upperFirst=value=>value?value.charAt(0).toLocaleUpperCase('ru-RU')+value.slice(1):'';

function aliasesByName(variants) {
  const groups=[];
  for(const row of variants||[]){
    let rawVariants=row.variants_json||row.variants||[];
    if(typeof rawVariants==='string'){
      try{rawVariants=JSON.parse(rawVariants)}catch{rawVariants=rawVariants.split(',')}
    }
    if(!Array.isArray(rawVariants))rawVariants=[];
    const preferred=String(row.preferred_name||row.preferredName||'').trim();
    if(preferred)groups.push({preferred,forms:new Set([preferred,...rawVariants].map(norm))});
  }
  return groups;
}

function canonicalFirstName(value,groups) {
  const first=String(value||'').trim(),key=norm(first);
  const matches=groups.filter(group=>group.forms.has(key));
  // Name-variant entries are often stored lowercased. They are lookup data,
  // never a signal to display a child name with a lowercase first letter.
  return upperFirst(matches.length===1?matches[0].preferred:first);
}
function sourceNameMatches(label,first,surname,groups) {
  const forms=new Set([norm(first)]);
  for(const group of groups)if(group.forms.has(norm(first)))for(const form of group.forms)forms.add(form);
  const lower=norm(label);
  for(const form of forms){
    if(lower===form)return true;
    if(!lower.startsWith(form+' '))continue;
    const suffix=family(lower.slice(form.length+1));
    if(suffix&&family(surname).startsWith(suffix))return true;
  }
  return false;
}
function chosenFamilyPrefix(owner,participants) {
  const surname=family(owner.surname);
  if(!surname)return '';
  const ownerBase=norm(owner.canonical);
  const competing=participants.filter(p=>p.admissionId!==owner.admissionId&&norm(p.canonical)===ownerBase);
  for(let n=1;n<=surname.length;n++){
    const prefix=surname.slice(0,n);
    if(competing.every(p=>!family(p.surname).startsWith(prefix)))
      return upperFirst(owner.surname.slice(0,n))+(n===1?'.':'');
  }
  return '';
}
function sourceHeader(line) {
  // Canonicalized reports have one "Child Prefix — body" line per child.
  // Retain the original punctuation and body verbatim on rewrite.
  return String(line).match(/^([^:\n—–]{1,90}?)\s*([:—–])\s*(.*)$/u);
}
function parentBody(text) {
  const head=sourceHeader(String(text||'').trim());
  return head?comparable(head[3]):'';
}

export function canonicalEducatorSource({
  kind,normalizedText,children=[],admissions=[],historyRows=[],nameVariants=[]
}={}) {
  const source=String(normalizedText||'');
  if(!['morning','evening'].includes(kind)||!source.trim())return source;
  const groups=aliasesByName(nameVariants);
  // Capitalize only proven name-like headers; do not alter their body, ordinary
  // paragraphs, headings such as "Общий комментарий" or owner identities.
  const knownForms=new Set([
    ...children.map(child=>norm(child.registered_first_name)),
    ...groups.flatMap(group=>[...group.forms])
  ]);
  const capitalizeKnownHeader=line=>{
    const header=sourceHeader(line);
    if(!header)return line;
    const first=String(header[1]||'').trim().split(/\s+/)[0];
    if(!knownForms.has(norm(first)))return line;
    return line.replace(/^(\s*)(\p{L})/u,(_match,space,letter)=>
      space+letter.toLocaleUpperCase('ru-RU'));
  };
  if(!historyRows.length)return source.split('\n').map(capitalizeKnownHeader).join('\n');
  const childById=new Map(children.map(c=>[String(c.child_id),c]));
  const admissionMap=new Map(admissions.map(a=>[String(a.admission_id),a]));
  const admissionsToInclude=new Set([
    ...admissions.filter(a=>a.status==='active').map(a=>String(a.admission_id)),
    ...historyRows.map(row=>String(row.admission_id||''))
  ]);
  const participants=[];
  for(const admissionId of admissionsToInclude){
    const admission=admissionMap.get(admissionId);
    const child=admission&&childById.get(String(admission.child_id));
    if(!child||!child.registered_first_name||!child.surname)continue;
    participants.push({
      admissionId,first:String(child.registered_first_name),
      surname:String(child.surname),
      canonical:canonicalFirstName(child.registered_first_name,groups)
    });
  }
  const byAdmission=new Map(participants.map(p=>[p.admissionId,p]));
  const byBody=new Map();
  for(const row of historyRows){
    if(row.kind!==kind)continue;
    const owner=byAdmission.get(String(row.admission_id||''));
    const body=parentBody(row.text);
    if(!owner||!body)continue;
    const candidates=byBody.get(body)||new Map();
    candidates.set(owner.admissionId,owner);
    byBody.set(body,candidates);
  }
  return source.split('\n').map(line=>{
    const header=sourceHeader(line);
    if(!header)return line;
    const candidates=byBody.get(comparable(header[3]));
    if(!candidates||candidates.size!==1)return line;
    const owner=[...candidates.values()][0];
    // Even a unique body is insufficient if the authored label conflicts
    // with the historical owner's actual name/surname.
    if(!sourceNameMatches(header[1],owner.first,owner.surname,groups))return line;
    const suffix=chosenFamilyPrefix(owner,participants);
    if(!suffix)return line; // Same full names cannot be safely distinguished.
    return upperFirst(owner.canonical)+' '+suffix+' '+header[2]+' '+header[3];
  }).map(capitalizeKnownHeader).join('\n');
}
