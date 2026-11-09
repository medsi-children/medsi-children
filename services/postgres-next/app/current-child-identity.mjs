// Pure, admission-free identity decisions for CURRENT parent registrations.
// Staff authors own the source text; no registration or matching changes it.
// Persistent child IDs are created only for registered children, never for
// names mentioned in an unregistered child's staff report.
const clean=v=>String(v??'').normalize('NFC').trim().replace(/\s+/gu,' ');
const norm=v=>clean(v).toLocaleLowerCase('ru-RU').replace(/ё/gu,'е');
const firstUpper=v=>v?v[0].toLocaleUpperCase('ru-RU')+v.slice(1):'';
const WORD=/^[\p{L}-]{1,100}$/u;
const HEADER=/^\s*([\p{L}-]{2,70})(?:[ \t]+([\p{L}-]{1,100})\.?)?[ \t]*[:：—–-][ \t]*(.*)$/u;
const GENERAL=/^\s*(?:общий\s+комментарий|сегодня\s+у\s+ребят\s+были|для\s+врачей|активности|итоги|дата|отчет\s+по\s+детям)\s*[:：]/iu;
const ACTIVE_KINDS=new Set(['morning','evening']);
function preferredName(name,variants){
  const entered=norm(name);
  if(!entered)return null;
  const entries=(variants||[]).filter(v=>{
    let forms=v.variants_json??v.variants??[];
    if(typeof forms==='string'){try{forms=JSON.parse(forms)}catch{forms=forms.split(',')}}
    if(!Array.isArray(forms))forms=[];
    return [v.preferred_name??v.preferredName,...forms].some(x=>norm(x)===entered);
  });
  if(entries.length>1)return null;
  return entries.length?norm(entries[0].preferred_name??entries[0].preferredName):entered;
}
export function canonicalCurrentName(name,nameVariants=[]){return preferredName(name,nameVariants)}
export function parseCurrentParentChildName(raw){
  const words=clean(raw).split(' ').filter(Boolean);
  if(!words.length||words.length>2||!words.every(x=>WORD.test(x)))return null;
  return {first:words[0],surname:words[1]||''};
}
export function currentStaffPublications(rows=[],today){
  // Latest publication of each report kind for the newest local report date.
  // Never use the previous day's report as proof that a child is still here.
  const valid=(rows||[]).filter(r=>ACTIVE_KINDS.has(String(r.kind))&&
    /^\d{4}-\d\d-\d\d$/.test(String(r.report_date||'')));
  const lastDate=valid.reduce((a,r)=>String(r.report_date)>a?String(r.report_date):a,'');
  if(!lastDate||today&&lastDate!==today)return [];
  const newest=new Map();
  for(const row of valid.filter(r=>r.report_date===lastDate)){
    const old=newest.get(row.kind);
    if(!old||Number(row.submitted_at||0)>Number(old.submitted_at||0))newest.set(row.kind,row);
  }
  return [...newest.values()];
}
export function parseCurrentStaffBlocks(text,nameVariants=[]){
  const blocks=[];
  let current=null;
  for(const line of String(text||'').replace(/\r\n?/g,'\n').split('\n')){
    if(GENERAL.test(line)){current=null;continue}
    const m=HEADER.exec(line);
    if(m){
      const key=preferredName(m[1],nameVariants);
      // Name-like headings are structural boundaries even if nobody has registered.
      current=key?{canonical:key,name:firstUpper(m[1]),prefix:norm(m[2]).replace(/\.$/,''),body:[m[3]]}:null;
      if(current)blocks.push(current);
    }else if(current)current.body.push(line);
  }
  return blocks;
}
export function registeredChildRoster({profiles=[],children=[]}={}){
  const used=new Set((profiles||[]).map(p=>String(p.child_id||'')).filter(Boolean));
  return (children||[]).filter(c=>used.has(String(c.child_id)));
}
// Return the UNIQUE CURRENT CHILD ID (never a prior admission id).
export function matchRegisteredChild({childName,profiles=[],children=[],nameVariants=[]}={}){
  const person=parseCurrentParentChildName(childName);
  const canonical=person&&preferredName(person.first,nameVariants);
  if(!canonical)return null;
  const candidates=registeredChildRoster({profiles,children})
    .filter(c=>preferredName(c.registered_first_name,nameVariants)===canonical);
  if(!candidates.length)return null;
  const expected=norm(person.surname);
  const matches=expected?candidates.filter(c=>norm(c.surname)===expected):candidates;
  return matches.length===1?{childId:String(matches[0].child_id),kind:'registered'}:null;
}
// Authoritative unmatched source enrollment. Conflicts never yield guesses.
export function matchCurrentSource({childName,publications=[],profiles=[],children=[],
  nameVariants=[],today}={}){
  const person=parseCurrentParentChildName(childName);
  const canonical=person&&preferredName(person.first,nameVariants);
  if(!canonical)return {status:'invalid'};
  const sameRegistered=registeredChildRoster({profiles,children})
    .filter(c=>preferredName(c.registered_first_name,nameVariants)===canonical);
  const existing=matchRegisteredChild({childName,profiles,children,nameVariants});
  // When the parent supplied only a first name, a newly appeared namesake
  // makes even an old unique registered child ambiguous.
  const source=currentStaffPublications(publications,today);
  const witnessed=source.flatMap(r=>parseCurrentStaffBlocks(r.normalized_text||r.raw_text,nameVariants)
    .map(b=>({...b,kind:r.kind}))).filter(b=>b.canonical===canonical);
  if(existing&&(!person.surname&&witnessed.some((b,i)=>i>0)))
    return {status:'ambiguous',reason:'new-namesake-in-source'};
  if(existing)return {status:'linked',...existing};
  // An existing current namesake with a conflicting surname cannot be
  // overridden by a bare heading; a second child needs explicit staff initials.
  const selected=currentStaffPublications(publications,today);
  if(!selected.length)return {status:'pending',reason:'no-current-publication'};
  const blocks=selected.flatMap(r=>parseCurrentStaffBlocks(r.normalized_text||r.raw_text,nameVariants)
    .map(b=>({...b,publicationId:r.publication_id,reportDate:r.report_date,kind:r.kind})));
  const candidates=blocks.filter(b=>b.canonical===canonical);
  if(!candidates.length)return {status:'pending',reason:'no-current-block'};
  // Different daily publications may describe the same child; each kind must
  // remain internally unique, and any explicit surname prefixes must agree.
  for(const kind of ACTIVE_KINDS){
    const inKind=candidates.filter(b=>b.kind===kind);
    if(inKind.length>1&&inKind.some(b=>!b.prefix))
      return {status:'ambiguous',reason:'duplicate-bare-headings'};
    if(inKind.length>1&&new Set(inKind.map(b=>b.prefix)).size!==inKind.length)
      return {status:'ambiguous',reason:'duplicate-prefixes'};
  }
  const personSurname=norm(person.surname);
  const possible=candidates.filter(b=>!b.prefix||
    personSurname&&personSurname.startsWith(b.prefix));
  if(!possible.length)return {status:!personSurname&&candidates.some(b=>b.prefix)?'ambiguous':'pending',
    reason:!personSurname?'missing-surname':'surname-conflict'};
  if(possible.length!==candidates.length&&possible.some(b=>!b.prefix))
    return {status:'ambiguous',reason:'bare-with-namesakes'};
  // A bare matching heading is only safe when it is the single child of that
  // name in every present source and no OTHER currently registered child of
  // that name competes for the block.
  const bare=possible.some(b=>!b.prefix);
  if(bare&&(sameRegistered.length||candidates.some(b=>b.prefix)))
    return {status:'ambiguous',reason:'unqualified-with-namesake'};
  const explicit=new Set(candidates.map(b=>b.prefix).filter(Boolean));
  if(explicit.size>1&&!personSurname)
    return {status:'ambiguous',reason:'multiple-surname-prefixes'};
  if(sameRegistered.length&&possible.some(b=>b.prefix&&
    sameRegistered.some(c=>norm(c.surname).startsWith(b.prefix))))
    return {status:'ambiguous',reason:'already-registered-owner'};
  if(candidates.some(b=>b.prefix)&&!personSurname)
    return {status:'ambiguous',reason:'missing-surname'};
  const matchingPrefixes=[...explicit].filter(p=>personSurname.startsWith(p));
  if(explicit.size&&matchingPrefixes.length!==1)return {status:'ambiguous',reason:'initial-conflict'};
  return {status:'new',canonical,firstName:firstUpper(canonical),
    surname:person.surname,sourceDate:selected[0].report_date};
}
// For each published block choose the shortest distinctive family prefix.
// A family prefix is a DISPLAY label only. Stored authored source stays intact.
export function shortestCurrentSurnamePrefixes(children=[],nameVariants=[]){
  const result=new Map();
  for(const child of children){
    const own=norm(child.surname),key=preferredName(child.registered_first_name,nameVariants);
    if(!own||!key)continue;
    const others=children.filter(c=>String(c.child_id)!==String(child.child_id)&&
      preferredName(c.registered_first_name,nameVariants)===key).map(c=>norm(c.surname));
    let prefix='';
    for(let n=1;n<=own.length;n++)if(others.every(s=>!s.startsWith(own.slice(0,n)))){
      prefix=firstUpper(String(child.surname).slice(0,n))+(n===1?'.':'');break;
    }
    if(prefix)result.set(String(child.child_id),prefix);
  }
  return result;
}
