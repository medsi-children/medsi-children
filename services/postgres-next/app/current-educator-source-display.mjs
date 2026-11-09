import {parseCurrentStaffBlocks,shortestCurrentSurnamePrefixes,
  canonicalCurrentName} from './current-child-identity.mjs';
const HEADER=/^(\s*)([\p{L}-]{2,70})(?:[ \t]+([\p{L}-]{1,100})\.?)?([ \t]*[:：—–-][ \t]*)(.*)$/u;
const norm=v=>String(v||'').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
// Display-only retrospective expansion: use the owner on THIS publication,
// never look at current names and guess which earlier child wrote its text.
// The stored staff text and parent history remain unchanged.
export function displayCurrentStaffSource({rawText,children=[],profiles=[],
  ownerRecords=[],nameVariants=[]}={}){
  const source=String(rawText||'');
  const registered=new Set(profiles.map(p=>String(p.child_id||'')).filter(Boolean));
  const active=children.filter(c=>registered.has(String(c.child_id)));
  const byId=new Map(active.map(c=>[String(c.child_id),c]));
  const prefix=shortestCurrentSurnamePrefixes(active,nameVariants);
  const owners=new Map();
  for(const item of ownerRecords){
    const key=String(item.owner_key||'');
    const index=Number(key.split('_').at(-1));
    if(!Number.isInteger(index)||index<0)continue;
    let record;
    try{record=JSON.parse(item.record_json)}catch{continue}
    if(record?.childId&&!record.blocked)owners.set(index,String(record.childId));
  }
  const blocks=parseCurrentStaffBlocks(source,nameVariants);
  const indexes=new Map(blocks.map((b,i)=>[b.lineIndex,i]));
  const lines=source.replace(/\r\n?/g,'\n').split('\n');
  return lines.map((line,lineIndex)=>{
    if(!indexes.has(lineIndex))return line;
    const m=HEADER.exec(line);
    if(!m)return line;
    const thisIndex=indexes.get(lineIndex);
    const owner=byId.get(owners.get(thisIndex));
    if(!owner)return line;
    if(canonicalCurrentName(m[2],nameVariants)!==
      canonicalCurrentName(owner.registered_first_name,nameVariants))return line;
    const unique=prefix.get(String(owner.child_id));
    if(!unique)return line;
    const canonical=String(owner.registered_first_name||'');
    const name=canonical.charAt(0).toLocaleUpperCase('ru-RU')+canonical.slice(1);
    return m[1]+name+' '+unique+m[4]+m[5];
  }).join('\n');
}
