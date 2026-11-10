import {planCurrentReport,currentReportVersion} from './current-report-plan.mjs';
import {currentStaffPublications,parseCurrentStaffBlocks,canonicalCurrentName} from './current-child-identity.mjs';
const PHONE=/^\d{10}$/;
const moscowDate=at=>{
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  const by=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return by.year+'-'+by.month+'-'+by.day;
};
// Recover only TODAY's latest staff source for a registered child.
// Previously published blocks are authorized by publication-scoped
// ownership; a deleted parent's old block is never reissued to a namesake.
export function createCurrentReportBackfill(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  async function recover({phone10=''}={}){
    if(phone10&&!PHONE.test(String(phone10)))throw new Error('Invalid phone.');
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[profiles],[children],[variants],[raw]]=await Promise.all([
        tx`SELECT phone10,child_id FROM parent_profiles`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT r.publication_id,r.kind,r.report_date,r.normalized_text,r.submitted_at,r.revision
          FROM report_publication_head AS h
          INNER JOIN raw_reports AS r ON r.publication_id=h.publication_id
          WHERE r.kind IN (${'morning'},${'evening'})`
      ]);
      const sources=currentStaffPublications(raw,moscowDate(now()));
      let backfilled=0;
      for(const source of sources){
        const prefix='CURRENT_BLOCK_'+source.publication_id+'_';
        const [ownerRows]=await tx`SELECT owner_key,record_json FROM report_ownership
          WHERE owner_key LIKE ${prefix+'%'}`;
        // Existing legacy publications have no CURRENT_BLOCK ownership
        // snapshot. Do not guess identities from old text during cutover.
        if(!ownerRows.length)continue;
        const owners=[],saved=new Map();
        for(const row of ownerRows){
          const index=Number(String(row.owner_key).slice(prefix.length));
          if(!Number.isSafeInteger(index)||index<0)continue;
          let record;
          try{record=JSON.parse(String(row.record_json||''))}
          catch{record={blocked:true}}
          owners[index]=record;
          saved.set(index,{key:row.owner_key,raw:row.record_json,record});
        }
        const plan=planCurrentReport({kind:source.kind,rawText:source.normalized_text||'',
          profiles,children,nameVariants:variants,priorBlockOwners:owners});
        for(const recipient of plan.recipients){
          if(phone10&&recipient.phone10!==phone10)continue;
          const child=children.find(c=>String(c.child_id)===recipient.childId);
          if(!child)continue;
          const version=currentReportVersion({kind:source.kind,
            childId:recipient.childId,text:recipient.text,publicationId:source.publication_id});
          const [[current]]=await tx`SELECT child_id,publication_id,text
            FROM parent_current_reports WHERE phone10=${recipient.phone10}
              AND kind=${source.kind}`;
          if(current&&current.child_id===recipient.childId&&
            current.publication_id===source.publication_id&&current.text===recipient.text)continue;
          const at=BigInt(source.submitted_at||now());
          await tx.upsert`INSERT INTO parent_current_reports
            (phone10,kind,child_id,publication_id,revision,text,version,read_version,updated_at)
            VALUES (${recipient.phone10},${source.kind},${recipient.childId},
              ${source.publication_id},${BigInt(source.revision||1)},${recipient.text},${version},${''},${at})`;
          await tx.upsert`INSERT INTO parent_report_history
            (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
            VALUES (${recipient.phone10},${source.kind},${source.report_date},
              ${recipient.childId},${source.publication_id},${BigInt(source.revision||1)},${recipient.text},${at})`;
          backfilled++;
        }
        // A pending block becomes owned by the SAME registered child after
        // late enrollment, without republishing or mutating the raw source.
        for(const next of plan.owners){
          const prior=saved.get(next.index);
          if(!prior?.record?.pending||!next.childId)continue;
          const replacement=JSON.stringify({childId:next.childId,blocked:false,pending:false});
          await tx`UPDATE report_ownership SET record_json=${replacement},
            updated_at=${BigInt(now())} WHERE owner_key=${prior.key}
            AND record_json=${prior.raw}`;
        }
      }
      return {ok:true,backfilled};
    });
  }
  // Repair ONLY the parent-facing history, never the live current report.
  // A snapshot with an explicit childId is authoritative even if a namesake
  // arrives later. For old unclaimed blocks, require both surname evidence
  // and continuity with an already-owned publication of this very child.
  // Legacy raw publications without a CURRENT_BLOCK snapshot are not guessed.
  async function recoverHistory({phone10}={}){
    if(!PHONE.test(String(phone10||'')))throw new Error('Invalid phone.');
    const today=moscowDate(now());
    const cutoff=moscowDate(now()-45*86400000);
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[[profile]],[children],[variants],[raw],[ownership],[existing]]=await Promise.all([
        tx`SELECT child_id FROM parent_profiles WHERE phone10=${phone10}`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT publication_id,kind,report_date,normalized_text,submitted_at,revision
          FROM raw_reports WHERE kind IN (${'morning'},${'evening'})
            AND report_date>=${cutoff} AND report_date<=${today}
          ORDER BY submitted_at DESC LIMIT 240`,
        tx`SELECT owner_key,record_json FROM report_ownership
          WHERE owner_key LIKE ${'CURRENT\\_BLOCK\\_%'}`,
        tx`SELECT kind,report_date FROM parent_report_history WHERE phone10=${phone10}`
      ]);
      const childId=String(profile?.child_id||'');
      const child=children.find(c=>String(c.child_id)===childId);
      if(!childId||!child)return {ok:true,backfilled:0};
      const canonical=canonicalCurrentName(child.registered_first_name,variants);
      if(!canonical)return {ok:true,backfilled:0};
      const roster=children.filter(c=>children.some(x=>x.child_id===c.child_id));
      const norm=v=>String(v||'').trim().normalize('NFC')
        .toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
      const already=new Set(existing.map(x=>String(x.kind)+'/'+String(x.report_date)));
      // Latest submitted source per day/kind; never resurrect a replaced draft.
      const latest=new Map();
      for(const source of raw){
        const key=String(source.kind)+'/'+String(source.report_date);
        const older=latest.get(key);
        if(!older||Number(source.submitted_at)>Number(older.submitted_at)||
          (Number(source.submitted_at)===Number(older.submitted_at)&&
           Number(source.revision)>Number(older.revision)))latest.set(key,source);
      }
      const snapshots=[];
      for(const source of latest.values()){
        const prefix='CURRENT_BLOCK_'+source.publication_id+'_';
        const saved=new Map();
        for(const row of ownership){
          if(!String(row.owner_key).startsWith(prefix))continue;
          const index=Number(String(row.owner_key).slice(prefix.length));
          if(!Number.isSafeInteger(index)||index<0)continue;
          let record;
          try{record=JSON.parse(String(row.record_json||''))}catch{record={blocked:true}}
          saved.set(index,record);
        }
        if(!saved.size)continue;
        snapshots.push({source,saved,blocks:parseCurrentStaffBlocks(source.normalized_text||'',variants)});
      }
      const anchors=snapshots.filter(({saved})=>[...saved.values()].some(r=>
        r&&!r.blocked&&String(r.childId||'')===childId))
        .map(({source})=>Date.parse(source.report_date+'T00:00:00Z')).filter(Number.isFinite);
      let backfilled=0;
      for(const {source,saved,blocks} of snapshots){
        const kind=String(source.kind),date=String(source.report_date);
        if(already.has(kind+'/'+date))continue;
        const eligible=blocks.flatMap((b,index)=>{
          const owner=saved.get(index);
          if(!owner||owner.blocked||!b.body.join('\n').trim()||b.canonical!==canonical)return [];
          if(b.prefix&&!norm(child.surname).startsWith(norm(b.prefix)))return [];
          if(owner.childId){
            return String(owner.childId)===childId?[{block:b,index,owned:true}]:[];
          }
          if(!owner.pending||norm(b.prefix).length<2)return [];
          // A past unregistered child may share the same first name. Limit
          // inferred history to seven preceding days of a verified, exact
          // child-owned publication; unqualified old names remain quarantined.
          const day=Date.parse(date+'T00:00:00Z');
          if(!anchors.some(at=>at>=day&&at-day<=7*86400000))return [];
          const peers=blocks.filter(x=>x.canonical===canonical);
          if(peers.some(x=>!x.prefix)||peers.some(x=>x!==b&&x.prefix===b.prefix))return [];
          const contenders=roster.filter(x=>
            canonicalCurrentName(x.registered_first_name,variants)===canonical&&
            norm(x.surname).startsWith(norm(b.prefix)));
          if(contenders.length!==1||String(contenders[0].child_id)!==childId)return [];
          return [{block:b,index,owned:false}];
        });
        // A source with two potentially relevant blocks is deliberately
        // skipped rather than silently choosing one.
        if(eligible.length!==1)continue;
        const {block}=eligible[0];
        const text=(child.registered_first_name||block.name)+': '+block.body.join('\n').trim();
        const at=BigInt(source.submitted_at||now());
        await tx.upsert`INSERT INTO parent_report_history
          (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
          VALUES (${phone10},${kind},${date},${childId},${source.publication_id},
            ${BigInt(source.revision||1)},${text},${at})`;
        already.add(kind+'/'+date);
        backfilled++;
      }
      return {ok:true,backfilled};
    });
  }
  return {recover,recoverHistory};
}
