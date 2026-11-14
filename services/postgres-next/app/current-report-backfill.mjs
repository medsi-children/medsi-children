import {planCurrentReport,currentReportVersion} from './current-report-plan.mjs';
import {currentStaffPublications,parseCurrentStaffBlocks,canonicalCurrentName,parseCurrentParentChildName} from './current-child-identity.mjs';
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
          // Preserve authored per-recipient edits and read markers for an
          // already delivered source, even if display punctuation was fixed
          // after this publication. Corrections publish a NEW source ID.
          const at=BigInt(source.submitted_at||now());
          if(current&&current.child_id===recipient.childId&&
            current.publication_id===source.publication_id){
            // A previously delivered current row does not prove that its
            // corresponding history row survived an interrupted migration.
            const [[savedHistory]]=await tx`SELECT publication_id FROM parent_report_history
              WHERE phone10=${recipient.phone10} AND kind=${source.kind}
                AND report_date=${source.report_date}`;
            if(!savedHistory){
              await tx.upsert`INSERT INTO parent_report_history
                (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
                VALUES (${recipient.phone10},${source.kind},${source.report_date},
                  ${recipient.childId},${source.publication_id},${BigInt(source.revision||1)},
                  ${String(current.text||recipient.text)},${at})`;
              backfilled++;
            }
            continue;
          }
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
  // Legacy blocks without ownership can be recovered only with verified child
  // continuity, a distinctive surname initial and no competing identity.
  async function recoverHistory({phone10}={}){
    if(!PHONE.test(String(phone10||'')))throw new Error('Invalid phone.');
    const today=moscowDate(now());
    const cutoff=moscowDate(now()-45*86400000);
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[[profile]],[children],[allProfiles],[variants],[raw],[ownership],[existing]]=await Promise.all([
        tx`SELECT child_id FROM parent_profiles WHERE phone10=${phone10}`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT child_id,child_name FROM parent_profiles`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT publication_id,kind,report_date,normalized_text,submitted_at,revision
          FROM raw_reports WHERE kind IN (${'morning'},${'evening'})
            AND report_date>=${cutoff} AND report_date<=${today}
          ORDER BY submitted_at DESC LIMIT 240`,
        tx`SELECT owner_key,record_json FROM report_ownership
          WHERE owner_key LIKE ${'CURRENT\\_BLOCK\\_%'}`,
        tx`SELECT kind,report_date,child_id,publication_id,text FROM parent_report_history WHERE phone10=${phone10}`
      ]);
      const childId=String(profile?.child_id||'');
      const child=children.find(c=>String(c.child_id)===childId);
      if(!childId||!child)return {ok:true,backfilled:0};
      const canonical=canonicalCurrentName(child.registered_first_name,variants);
      if(!canonical)return {ok:true,backfilled:0};
      // Include children without an active parent so a former namesake can
      // still prevent a retroactive first-initial attribution.
      const roster=children;
      const norm=v=>String(v||'').trim().normalize('NFC')
        .toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
      const existingByDay=new Map(existing.map(x=>[String(x.kind)+'/'+String(x.report_date),x]));
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
        const saved=new Map(),originals=new Map();
        for(const row of ownership){
          if(!String(row.owner_key).startsWith(prefix))continue;
          const index=Number(String(row.owner_key).slice(prefix.length));
          if(!Number.isSafeInteger(index)||index<0)continue;
          let record;
          try{record=JSON.parse(String(row.record_json||''))}catch{record={blocked:true}}
          saved.set(index,record);
          originals.set(index,{key:row.owner_key,raw:row.record_json});
        }
        snapshots.push({source,saved,originals,
          blocks:parseCurrentStaffBlocks(source.normalized_text||'',variants)});
      }
      // Only existing child-scoped deliveries and explicit block owners
      // establish continuity. A newly guessed block never anchors another.
      const anchors=[...new Set([
        ...snapshots.filter(({saved})=>[...saved.values()].some(r=>
          r&&!r.blocked&&String(r.childId||'')===childId))
          .map(({source})=>Date.parse(source.report_date+'T00:00:00Z')),
        ...existing.filter(r=>String(r.child_id||'')===childId)
          .map(r=>Date.parse(String(r.report_date)+'T00:00:00Z'))
      ].filter(Number.isFinite))];
      let backfilled=0;
      for(const {source,saved,originals,blocks} of snapshots){
        const kind=String(source.kind),date=String(source.report_date);
        const priorHistory=existingByDay.get(kind+'/'+date);
        // An old migrated row can still exist without its verified child_id.
        // Never overwrite a report for another child or a different source.
        if(priorHistory&&(String(priorHistory.child_id||'')||
          String(priorHistory.publication_id||'')!==String(source.publication_id)))continue;
        const eligible=blocks.flatMap((b,index)=>{
          const owner=saved.get(index);
          if(owner?.blocked||!b.body.join('\n').trim()||b.canonical!==canonical)return [];
          // A partly snapshotted source is not a legacy unowned source.
          if(!owner&&saved.size)return [];
          if(b.prefix&&!norm(child.surname).startsWith(norm(b.prefix)))return [];
          if(owner?.childId){
            return String(owner.childId)===childId?[{block:b,index,owned:true}]:[];
          }
          if(owner&&!owner.pending)return [];
          // One-character family initials are accepted only when a real
          // linked child has subsequent independently verified reports.
          // Bare first names and conflicting namesakes remain unclaimed.
          const surnamePrefix=norm(b.prefix);
          if(!surnamePrefix||!norm(child.surname).startsWith(surnamePrefix))return [];
          const day=Date.parse(date+'T00:00:00Z'),horizon=14*86400000;
          const future=anchors.filter(at=>at>day&&at-day<=horizon);
          if(!future.length)return [];
          // An unowned legacy source has no historical claim snapshot. For
          // a single initial require two distinct already verified report
          // dates, rather than trusting one later occurrence of the name.
          if(!owner&&surnamePrefix.length===1&&future.length<2)return [];
          if(surnamePrefix.length===1&&
            !future.some(at=>at-day<=7*86400000)&&future.length<2)return [];
          const peers=blocks.filter(x=>x.canonical===canonical);
          if(peers.some(x=>!x.prefix)||peers.some(x=>x!==b&&
            (x.prefix===b.prefix||norm(x.prefix).startsWith(surnamePrefix)||
              surnamePrefix.startsWith(norm(x.prefix)))))return [];
          const contenders=roster.filter(x=>
            canonicalCurrentName(x.registered_first_name,variants)===canonical&&
            norm(x.surname).startsWith(surnamePrefix));
          if(contenders.length!==1||String(contenders[0].child_id)!==childId)return [];
          // Unlinked families with a different matching surname must not be
          // silently overridden by today's linked roster.
          if(allProfiles.some(p=>{
            if(String(p.child_id||''))return false;
            const name=parseCurrentParentChildName(p.child_name);
            return name&&canonicalCurrentName(name.first,variants)===canonical&&
              norm(name.surname).startsWith(surnamePrefix)&&
              norm(name.surname)!==norm(child.surname);
          }))return [];
          // Historical ownership of this initial by another child nearby
          // is stronger evidence than the currently linked family's name.
          if(snapshots.some(({source:other,saved:otherOwners,blocks:otherBlocks})=>{
            const at=Date.parse(String(other.report_date)+'T00:00:00Z');
            return Math.abs(at-day)<=horizon&&otherBlocks.some((otherBlock,i)=>
              otherBlock.canonical===canonical&&
              norm(otherBlock.prefix).startsWith(surnamePrefix)&&
              otherOwners.get(i)?.childId&&
              String(otherOwners.get(i).childId)!==childId);
          }))return [];
          return [{block:b,index,owned:false}];
        });
        // A source with two potentially relevant blocks is deliberately
        // skipped rather than silently choosing one.
        if(eligible.length!==1)continue;
        const {block,index,owned}=eligible[0];
        const text=(child.registered_first_name||block.name)+': '+block.body.join('\n').trim();
        // In an unowned legacy source, parent history must also reproduce
        // the selected block. Otherwise a stale orphan may belong to another
        // child despite sharing this publication and report date.
        if(priorHistory&&!owned){
          const savedText=String(priorHistory.text||'').trim();
          const originalBody=block.body.join('\n').trim();
          // Legacy personalised reports can use a nickname instead of the
          // registered first name. Compare the entire source body, never
          // just the heading or a substring of another child's paragraph.
          const savedBody=/^[^:：\n]{1,100}[:：][ \t]*([\s\S]*)$/u.exec(savedText)?.[1]?.trim();
          if(savedText!==text.trim()||!savedBody){
            if(!savedBody||savedBody!==originalBody)continue;
          }
        }
        const at=BigInt(source.submitted_at||now());
        if(!owned){
          // Claim the exact historic source block at the same time as the
          // recipient's history row. A later namesake cannot inherit it.
          const original=originals.get(index);
          const replacement=JSON.stringify({childId,pending:false,blocked:false});
          if(original){
            const [changed]=await tx`UPDATE report_ownership SET
              record_json=${replacement},updated_at=${BigInt(now())}
              WHERE owner_key=${original.key} AND record_json=${original.raw}
              RETURNING owner_key`;
            if(changed.length!==1)throw new Error('Historical block ownership changed.');
          }else{
            // Sources predating ownership snapshots can be claimed only
            // after the independent continuity and namesake checks above.
            const [inserted]=await tx`INSERT INTO report_ownership
              (owner_key,record_json,updated_at)
              VALUES (${'CURRENT_BLOCK_'+source.publication_id+'_'+index},
                ${replacement},${BigInt(now())})
              ON CONFLICT (owner_key) DO NOTHING RETURNING owner_key`;
            if(inserted.length!==1)throw new Error('Historical block ownership changed.');
          }
        }
        if(priorHistory){
          // Restore only the missing identity column. Preserve historic text,
          // author edits, timestamps, publication and every read marker.
          const [updated]=await tx`UPDATE parent_report_history SET child_id=${childId}
            WHERE phone10=${phone10} AND kind=${kind} AND report_date=${date}
              AND child_id=${''} AND publication_id=${source.publication_id}
            RETURNING child_id`;
          if(updated.length!==1)throw new Error('Historical parent identity changed.');
        }else{
          await tx.upsert`INSERT INTO parent_report_history
            (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
            VALUES (${phone10},${kind},${date},${childId},${source.publication_id},
              ${BigInt(source.revision||1)},${text},${at})`;
        }
        existingByDay.set(kind+'/'+date,{child_id:childId,publication_id:source.publication_id});
        backfilled++;
      }
      return {ok:true,backfilled};
    });
  }
  return {recover,recoverHistory};
}
