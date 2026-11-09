import {deletionCutoff} from './deleted-source-guard.mjs';
import {createHash} from 'node:crypto';
import {canonicalRegisteredName} from './parent-admission-matching.mjs';

const norm=value=>String(value||'').trim().normalize('NFC')
  .toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const reportVersion=(kind,admissionId,text)=>createHash('sha256')
  .update(kind+'\u0000'+admissionId+'\u0000'+text,'utf8').digest('hex');
const EMPTY='Пока ещё нет отчёта 🙏';
const HEADER=/^\s*([\p{L}-]{2,60})(?:\s+([\p{L}-]{1,80})\.?)?\s*[:：—–-]\s*(.*)$/u;
// Parse structural boundaries independently from the list of registered
// children: a later registration must never swallow an unknown child's text.
const normalizedBody=value=>String(value||'').replace(/[ \t]*\n[ \t]*/g,'\n')
  .replace(/\n+/g,' ').replace(/[ \t]{2,}/g,' ')
  .replace(/[ \t]+([,.])/g,'$1').replace(/\([ \t]+/g,'(')
  .replace(/[ \t]+\)/g,')').replace(/,(?=[А-Яа-яЁёA-Za-z])/g,', ')
  .replace(/([а-яёa-z])\.([А-ЯЁA-Z])/gu,'$1. $2').trim();
const cleanFingerprint=value=>String(value||'').replace(/\r\n?/g,'\n')
  .replace(/[\u2028\u2029]/g,'\n').replace(/[\u200B-\u200F\uFEFF]/g,'')
  .replace(/[\u00A0\u202F\u2000-\u200A]/g,' ')
  .replace(/[\u2010-\u2015\u2212]/g,'-')
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,'')
  .replace(/[ \t]+/g,' ').replace(/[ \t]+\n/g,'\n')
  .replace(/\n{3,}/g,'\n\n').trim().normalize('NFC');
function sourceOwnershipKey(kind,block){
  const value=cleanFingerprint(block.canonical+'\n'+normalizedBody(block.lines.join('\n')));
  return 'RAW_REPORT_OWNER_'+kind+'_'+createHash('sha256').update(value,'utf8').digest('base64url');
}
const GENERAL=/^\s*(?:ОБЩИЙ КОММЕНТАРИЙ|Общий комментарий|Сегодня у ребят были|Для врачей)\s*[:：]/iu;

function namedBlocks(source,activeChildren,nameVariants){
  const known=new Set(activeChildren.map(c=>canonicalRegisteredName(c.registered_first_name,nameVariants)).filter(Boolean));
  const entries=[];
  let current=null;
  for(const line of String(source||'').replace(/\r\n?/g,'\n').split('\n')){
    if(GENERAL.test(line)){current=null;continue}
    const match=HEADER.exec(line);
    const canonical=match?canonicalRegisteredName(match[1],nameVariants):null;
    if(match){
      if(canonical&&known.has(canonical)){
        current={canonical,label:match[1],suffix:norm(match[2]).replace(/\.$/,''),lines:[match[3]]};
        entries.push(current);
      }else{
        // Unknown/unregistered child's heading (or a non-child heading)
        // terminates the previous block. Never copy it to another child.
        current=null;
      }
      continue;
    }
    if(current)current.lines.push(line);
  }
  return entries;
}

// Returns a single child's block only when it can be assigned to that exact
// active hospital child. Identical names without distinct initials are never
// distributed by inference; publication data from other children stays sealed.
export function findPublishedSourceForChild({
  normalizedText='',child,activeChildren=[],nameVariants=[],
  kind='',admissionId='',ownershipRecords=null
}={}){
  if(!child||!Array.isArray(activeChildren)||!activeChildren.length)return null;
  const target=canonicalRegisteredName(child.registered_first_name,nameVariants);
  if(!target)return null;
  const roster=activeChildren.filter(c=>
    canonicalRegisteredName(c.registered_first_name,nameVariants)===target);
  if(roster.some(c=>!c.child_id)||!roster.some(c=>String(c.child_id)===String(child.child_id)))return null;
  const blocks=namedBlocks(normalizedText,activeChildren,nameVariants)
    .filter(b=>b.canonical===target);
  if(!blocks.length)return null;
  // With multiple blocks of the same name, each must carry a distinct usable
  // surname prefix; a bare repeated name is not ownership evidence.
  if(blocks.length>1&&
    (blocks.some(b=>!b.suffix)||new Set(blocks.map(b=>b.suffix)).size!==blocks.length))return null;
  const matches=blocks.filter(block=>{
    if(!block.suffix)return roster.length===1&&blocks.length===1;
    const matchingChildren=roster.filter(c=>norm(c.surname).startsWith(block.suffix));
    return matchingChildren.length===1&&String(matchingChildren[0].child_id)===String(child.child_id);
  });
  if(matches.length!==1)return null;
  // A saved owner is authoritative. A blocked or other-admission owner
  // must not be reassigned by the roster's present-day name uniqueness.
  if(ownershipRecords){
    const raw=ownershipRecords.get(sourceOwnershipKey(kind,matches[0]));
    if(raw!==undefined){
      let owner;
      try{owner=JSON.parse(raw)}catch{return null}
      if(!owner||owner.blocked||!owner.childAdmissionId||
        String(owner.childAdmissionId)!==String(admissionId))return null;
    }
  }
  const body=matches[0].lines.join('\n').trim();
  if(!body)return null;
  return matches[0].label.charAt(0).toLocaleUpperCase('ru-RU')+
    matches[0].label.slice(1)+': '+body;
}

// Newly registered parents are not in the publication recipient snapshot.
// Backfill ONLY the current recent educator source for a verified admission,
// with deterministic name/surname ownership. Idempotent, no older report
// edits, no re-publication, no push notification and no cross-admission data.
export async function backfillRecentEducatorReports(sql,{phone10='',now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL unavailable.');
  if(phone10&&!/^\d{10}$/.test(String(phone10)))throw new Error('Invalid parent phone.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    const [[profiles],[admissions],[children],[current],[heads],[nameVariants]]=await Promise.all([
      phone10
        ?tx`SELECT phone10,child_id,admission_id FROM parent_profiles WHERE phone10=${phone10}`
        :tx`SELECT phone10,child_id,admission_id FROM parent_profiles`,
      tx`SELECT admission_id,child_id,status FROM admissions`,
      tx`SELECT child_id,registered_first_name,surname FROM children`,
      tx`SELECT phone10,kind,admission_id,text FROM parent_current_reports`,
      tx`SELECT kind,publication_id FROM report_publication_head`,
      tx`SELECT base_key,preferred_name,variants_json FROM name_variants`
    ]);
    const admissionById=new Map(admissions.filter(a=>a.status==='active')
      .map(a=>[String(a.admission_id),a]));
    const childById=new Map(children.map(c=>[String(c.child_id),c]));
    const activeChildren=[...new Set([...admissionById.values()].map(a=>String(a.child_id)))]
      .map(id=>childById.get(id)).filter(Boolean);
    const currentByKey=new Map(current.map(row=>[String(row.phone10)+'/'+row.kind,row]));
    const validProfiles=profiles.filter(p=>{
      const admission=admissionById.get(String(p.admission_id));
      return admission&&String(admission.child_id)===String(p.child_id)&&
        /^\d{10}$/.test(String(p.phone10));
    });
    if(!validProfiles.length)return {backfilled:0};
    let backfilled=0;
    for(const kind of ['morning','evening']){
      const head=heads.find(h=>h.kind===kind&&h.publication_id);
      if(!head)continue;
      const [[publication]]=await tx`SELECT publication_id,kind,report_date,submitted_at,
        revision,normalized_text FROM raw_reports WHERE publication_id=${head.publication_id}`;
      if(!publication||publication.kind!==kind||!String(publication.normalized_text||'').trim())continue;
      const publishedAt=Number(publication.submitted_at||0);
      const age=now()-publishedAt;
      if(!Number.isFinite(age)||age<0||age>7*24*60*60*1000)continue;
      const [ownerRows]=await tx`SELECT owner_key,record_json FROM report_ownership
        WHERE owner_key LIKE ${'RAW_REPORT_OWNER_'+kind+'_%'}`;
      const ownershipRecords=new Map(ownerRows.map(row=>[String(row.owner_key),String(row.record_json)]));
      for(const profile of validProfiles){
        const existing=currentByKey.get(String(profile.phone10)+'/'+kind);
        if(existing&&String(existing.admission_id)===String(profile.admission_id)&&
          String(existing.text||'').trim()&&String(existing.text).trim()!==EMPTY)continue;
        const child=childById.get(String(profile.child_id));
        const text=findPublishedSourceForChild({
          normalizedText:publication.normalized_text,child,activeChildren,nameVariants,
          kind,admissionId:profile.admission_id,ownershipRecords
        });
        if(!text)continue;
        const cutoff=await deletionCutoff(tx,canonicalRegisteredName(child.registered_first_name,nameVariants));
        if(cutoff&&publishedAt<=cutoff)continue;
        // Never replace a historical record from a different admission if
        // this phone number was used by a parent during an earlier stay.
        const [[history]]=await tx`SELECT admission_id FROM parent_report_history
          WHERE phone10=${profile.phone10} AND kind=${kind}
            AND report_date=${publication.report_date}`;
        if(history&&String(history.admission_id)!==String(profile.admission_id))continue;
        const version=reportVersion(kind,String(profile.admission_id),text);
        const at=BigInt(publishedAt),revision=BigInt(publication.revision||0);
        await tx.upsert`INSERT INTO parent_current_reports
          (phone10,kind,admission_id,publication_id,revision,text,version,read_version,updated_at)
          VALUES (${profile.phone10},${kind},${profile.admission_id},
            ${publication.publication_id},${revision},${text},${version},${''},${at})`;
        await tx.upsert`INSERT INTO parent_report_history
          (phone10,kind,report_date,admission_id,publication_id,revision,text,captured_at)
          VALUES (${profile.phone10},${kind},${publication.report_date},
            ${profile.admission_id},${publication.publication_id},
            ${revision},${text},${at})`;
        backfilled++;
      }
    }
    return {backfilled};
  });
}
