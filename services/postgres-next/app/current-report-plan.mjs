import {createHash} from 'node:crypto';
import {normalizeCurrentReportPunctuation} from './current-report-punctuation.mjs';
import {canonicalCurrentName,parseCurrentStaffBlocks,registeredChildRoster} from './current-child-identity.mjs';
const PHONE=/^\d{10}$/;
const norm=v=>String(v||'').normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const hash=v=>createHash('sha256').update(v,'utf8').digest('hex');
const KINDS=new Set(['morning','evening','psychology']);
const prefixMatch=(surname,prefix)=>!!norm(surname)&&norm(surname).startsWith(norm(prefix));
const headerFor=b=>b.name+(b.prefix?' '+b.prefix:'')+': ';
// The raw staff source is immutable. A child block is assigned to one CURRENT
// registered child ID, or quarantined. A parent row never creates a child.
// Prior source ownership is by exact publication/block, not a hospital stay.
export function planCurrentReport({kind,rawText,profiles=[],children=[],nameVariants=[],
  priorBlockOwners=[],manualResolutions=[]}={}){
  if(!KINDS.has(kind))throw new Error('Unknown report kind.');
  if(typeof rawText!=='string'||!rawText.trim()||rawText.length>240000)
    throw new Error('Invalid staff source.');
  const normalizedText=normalizeCurrentReportPunctuation(rawText);
  const registered=profiles.filter(p=>PHONE.test(String(p.phone10||'')));
  const parentIds=new Set();
  for(const p of registered){
    if(parentIds.has(p.phone10))throw new Error('Duplicate parent contact.');
    parentIds.add(p.phone10);
  }
  if(kind==='psychology'){
    return {kind,normalizedText,rawText,
      recipients:registered.map(p=>({phone10:p.phone10,childId:'',text:normalizedText})),
      owners:[],unresolved:[]};
  }
  const roster=registeredChildRoster({profiles:registered,children});
  const childById=new Map(roster.map(c=>[String(c.child_id),c]));
  const sourceBlocks=parseCurrentStaffBlocks(normalizedText,nameVariants)
    .map((b,index)=>({...b,index,bodyText:b.body.join('\n').trim()}));
  const groups=new Map();
  for(const b of sourceBlocks){
    const g=groups.get(b.canonical)||[];
    g.push(b);groups.set(b.canonical,g);
  }
  const assigned=new Map(),blockedChildren=new Set(),owners=[],unresolved=[];
  const confirmed=new Map(manualResolutions.map(r=>[r.index,r]));
  for(const block of sourceBlocks){
    const family=roster.filter(c=>canonicalCurrentName(c.registered_first_name,nameVariants)===block.canonical);
    const siblingBlocks=groups.get(block.canonical)||[];
    let candidates=block.prefix
      ?family.filter(c=>prefixMatch(c.surname,block.prefix))
      :family;
    const recorded=priorBlockOwners[block.index];
    const explicit=confirmed.get(block.index);
    if(explicit?.choice==='child'){
      // Explicit educator choice is accepted only after the publishing
      // transaction revalidated it against its live roster preflight.
      candidates=candidates.filter(c=>String(c.child_id)===String(explicit.childId));
    }else if(explicit?.choice?.startsWith('other-')){
      candidates=[];
    }else if(recorded?.childId&&!recorded.blocked){
      // Verified owner from the same logical block in a previous revision.
      // A newly bare heading can keep that original identity.
      candidates=candidates.filter(c=>String(c.child_id)===String(recorded.childId));
    }else{
      if(!block.prefix&&(family.length!==1||siblingBlocks.length!==1))candidates=[];
      if(siblingBlocks.length>1&&siblingBlocks.some(b=>!b.prefix))candidates=[];
      if(block.prefix&&siblingBlocks.some(b=>b!==block&&b.prefix===block.prefix))candidates=[];
    }
    if(recorded===null||recorded?.blocked)candidates=[];
    const unique=candidates.length===1&&!!block.bodyText;
    const childId=unique?String(candidates[0].child_id):'';
    // One block can serve two parents of the SAME child. It must never
    // serve multiple child IDs, and one child cannot get two source blocks.
    if(childId&&(assigned.has(childId)||blockedChildren.has(childId))){
      assigned.delete(childId);
      blockedChildren.add(childId);
      for(const earlier of owners)if(earlier.childId===childId){
        earlier.childId='';earlier.blocked=true;earlier.pending=false;
      }
      owners.push({index:block.index,childId:'',blocked:true});
      unresolved.push({index:block.index,reason:'duplicate-child-block'});
    }else if(childId){
      assigned.set(childId,{...block,childId});
      owners.push({index:block.index,childId});
    }else{
      // A clearly distinguishable source block without a registered parent
      // is unclaimed, not quarantined. Late registration can claim it if the
      // latest report still proves a UNIQUE matching surname/name.
      const competingSource=siblingBlocks.filter(b=>b!==block&&
        (!b.prefix||!block.prefix||b.prefix===block.prefix));
      const competitors=family.filter(c=>!block.prefix||
        prefixMatch(c.surname,block.prefix));
      const pending=explicit?.choice==='other-new'||
        (!explicit&&!recorded&&competingSource.length===0&&competitors.length===0);
      owners.push({index:block.index,childId:'',pending,blocked:!pending});
      unresolved.push({index:block.index,
        reason:pending?'awaiting-parent':'unresolved-or-ambiguous'});
    }
  }
  return {kind,rawText,normalizedText,owners,unresolved,
    recipients:registered.flatMap(p=>{
      const childId=String(p.child_id||''),block=assigned.get(childId);
      const child=childById.get(childId);
      if(!block||!child)return [];
      // Display the canonical child name without retroactively changing the
      // educator-authored text (and without accepting other namesakes).
      const name=child.registered_first_name||block.name;
      return [{phone10:p.phone10,childId,text:name+': '+block.bodyText}];
    })};
}
export function currentReportVersion({kind,childId='',text='',publicationId=''}) {
  return hash([kind,childId,publicationId,text].join('\u0000'));
}
