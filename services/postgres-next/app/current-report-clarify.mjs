import {createHash} from 'node:crypto';
import {canonicalCurrentName,parseCurrentStaffBlocks,registeredChildRoster} from './current-child-identity.mjs';
import {normalizeCurrentReportPunctuation} from './current-report-punctuation.mjs';

const norm=x=>String(x||'').normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const nameOf=child=>[child.registered_first_name,child.surname].filter(Boolean).join(' ');
const same=a=>String(a||'');

// No patient source or ID goes into a log or a public token. All assignments
// are revalidated with the live roster inside the publishing transaction.
export function reviewCurrentReport({kind,rawText,profiles=[],children=[],nameVariants=[],
  correctionOf='',headId=''}={}){
  if(!['morning','evening','psychology'].includes(kind)||
    typeof rawText!=='string'||!rawText.trim()||rawText.length>240000)
    throw new Error('Invalid report clarification request.');
  const roster=registeredChildRoster({profiles,children});
  const blocks=kind==='psychology'?[]:
    parseCurrentStaffBlocks(normalizeCurrentReportPunctuation(rawText),nameVariants);
  const groups=new Map();
  blocks.forEach(b=>groups.set(b.canonical,(groups.get(b.canonical)||0)+1));
  const conflicts=[];
  blocks.forEach((b,index)=>{
    const family=roster.filter(c=>
      canonicalCurrentName(c.registered_first_name,nameVariants)===b.canonical);
    const candidate=b.prefix?family.filter(c=>norm(c.surname).startsWith(norm(b.prefix))):family;
    // A unique, fully-qualified child is safe; a bare name with competing
    // registered children is not. Unregistered children cannot be guessed.
    if(candidate.length<2&&!(family.length>1&&!b.prefix)&&
      !(groups.get(b.canonical)>1&&!b.prefix&&candidate.length>0))return;
    conflicts.push({index,name:b.name,heading:b.name+(b.prefix?' '+b.prefix+'.':''),
      excerpt:b.body.join('\n').slice(0,350),
      candidates:candidate.map(c=>({childId:String(c.child_id),
        name:nameOf(c),phones:profiles.filter(p=>same(p.child_id)===same(c.child_id))
          .map(p=>String(p.phone10||'')).filter(Boolean)}))});
  });
  const rosterKey=roster.map(c=>[String(c.child_id),norm(c.registered_first_name),norm(c.surname)])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  const profileKey=profiles.map(p=>[String(p.phone10||''),String(p.child_id||'')])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  const token=hash({kind,rawText,correctionOf,headId,rosterKey,profileKey,
    variants:nameVariants.map(v=>[v.base_key,v.preferred_name,v.variants_json])});
  return {ok:true,token,conflicts};
}

// Preserve ownership only when a source block still has a distinctive
// identity in BOTH revisions; never use its former numeric position.
// Text itself is editable. A changed first name is resolved from the current
// roster or educator clarification, not claimed by the former indexed owner.
export function remapCurrentBlockOwners({beforeText='',afterText='',priorOwners=[],
  nameVariants=[],children=[]}={}){
  const before=parseCurrentStaffBlocks(beforeText,nameVariants);
  const after=parseCurrentStaffBlocks(afterText,nameVariants);
  const result=Array(after.length).fill(undefined);
  const used=new Set();
  const candidates=(fresh,old,owner)=>{
    if(!owner||!owner.childId||owner.blocked||fresh.canonical!==old.canonical)return false;
    const child=children.find(c=>same(c.child_id)===same(owner.childId));
    if(!child)return false;
    if(fresh.prefix&&!norm(child.surname).startsWith(norm(fresh.prefix)))return false;
    if(old.prefix&&!norm(child.surname).startsWith(norm(old.prefix)))return false;
    return true;
  };
  // Do not transfer the old owner if its block has been removed. Body edits
  // and surname-prefix edits are accepted when an owner is uniquely proven.
  for(let i=0;i<after.length;i++){
    const b=after[i];
    const possible=before.flatMap((old,j)=>{
      const owner=priorOwners[j];
      return !used.has(j)&&candidates(b,old,owner)?[{j,owner,old}]:[];
    });
    if(possible.length!==1)continue;
    const {j,owner}=possible[0];
    const competingNew=after.filter(x=>x.canonical===b.canonical&&
      (!x.prefix||!b.prefix||x.prefix===b.prefix));
    const overlappingOld=before.filter((x,k)=>k!==j&&x.canonical===b.canonical&&
      (!x.prefix||!b.prefix||x.prefix===b.prefix));
    if(competingNew.length>1||overlappingOld.length>0)continue;
    result[i]={childId:String(owner.childId)};
    used.add(j);
  }
  return result;
}

export function checkedCurrentResolutions({preview,resolutions=[],token}={}){
  if(!Array.isArray(resolutions)||resolutions.length>120||
    resolutions.some(x=>!x||!Number.isSafeInteger(x.index)||x.index<0||
      !['child','other-new','other-later'].includes(x.choice)))
    throw new Error('Invalid report clarification choices.');
  if(resolutions.length&&!token)throw new Error('Report clarification expired. Reopen confirmation.');
  if(token&&preview.token!==token)
    throw new Error('Report roster changed. Review recipients again.');
  const expected=new Map((preview.conflicts||[]).map(x=>[x.index,x]));
  const seen=new Set();
  for(const decision of resolutions){
    if(seen.has(decision.index)||!expected.has(decision.index))
      throw new Error('Invalid report clarification choices.');
    seen.add(decision.index);
    if(decision.choice==='child'&&!expected.get(decision.index).candidates.some(c=>c.childId===decision.childId))
      throw new Error('Invalid child selected for report.');
    if(decision.choice!=='child'&&decision.childId)
      throw new Error('Invalid report clarification choices.');
  }
  // An older client can still publish a source: all ambiguous blocks will be
  // quarantined by the planner, never silently delivered to a parent.
  if(token&&seen.size!==expected.size)
    throw new Error('Report clarification incomplete.');
  return resolutions;
}
