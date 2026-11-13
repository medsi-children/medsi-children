import {createHash,randomUUID} from 'node:crypto';
import {canonicalCurrentName,parseCurrentParentChildName,parseCurrentStaffBlocks} from './current-child-identity.mjs';

const norm=v=>String(v||'').normalize('NFC').trim().toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const phone=/^\d{10}$/;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const mosDate=at=>{
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at)).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};

// Educator-reviewed attribution for one immutable historical source block.
// The source text is never rewritten; only a publication-scoped owner and
// parent-facing history row are created in the same serializable transaction.
export function createCurrentReportHistoryReview(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  async function snapshot(tx){
    const today=mosDate(now()),cutoff=mosDate(now()-45*86400000);
    const [profiles]=await tx`SELECT phone10,parent_name,child_name,child_id,profile_generation FROM parent_profiles`;
    const [children]=await tx`SELECT child_id,registered_first_name,surname FROM children`;
    const [variants]=await tx`SELECT base_key,preferred_name,variants_json FROM name_variants`;
    const [raw]=await tx`SELECT publication_id,kind,report_date,normalized_text,submitted_at,revision
      FROM raw_reports WHERE kind IN (${'morning'},${'evening'}) AND report_date>=${cutoff} AND report_date<=${today}
      ORDER BY submitted_at DESC LIMIT 480`;
    const [owners]=await tx`SELECT owner_key,record_json FROM report_ownership WHERE owner_key LIKE ${'CURRENT\\_BLOCK\\_%'}`;
    const [history]=await tx`SELECT phone10,kind,report_date,child_id,publication_id FROM parent_report_history
      WHERE report_date>=${cutoff} AND report_date<=${today}`;
    return {profiles,children,variants,raw,owners,history,today,cutoff};
  }
  function entries(data){
    const latest=new Map();
    for(const r of data.raw){const key=`${r.kind}/${r.report_date}`,old=latest.get(key);
      if(!old||Number(r.submitted_at)>Number(old.submitted_at)||Number(r.submitted_at)===Number(old.submitted_at)&&Number(r.revision)>Number(old.revision))latest.set(key,r);}
    const result=[];
    for(const source of latest.values()){
      const prefix=`CURRENT_BLOCK_${source.publication_id}_`,saved=new Map();
      for(const row of data.owners){if(!String(row.owner_key).startsWith(prefix))continue;
        const index=Number(String(row.owner_key).slice(prefix.length));if(!Number.isSafeInteger(index)||index<0)continue;
        try{saved.set(index,JSON.parse(String(row.record_json||'')))}catch{saved.set(index,{blocked:true})}}
      const blocks=parseCurrentStaffBlocks(source.normalized_text||'',data.variants);
      blocks.forEach((block,index)=>{
        if(!block.body.join('\n').trim())return;
        const owner=saved.get(index);
        if(owner?.childId||owner===null)return;
        if(data.history.some(h=>h.kind===source.kind&&h.report_date===source.report_date&&h.publication_id===source.publication_id))return;
        const candidates=[];
        for(const p of data.profiles){
          if(!phone.test(String(p.phone10||'')))continue;
          const person=parseCurrentParentChildName(p.child_name);
          if(!person||!person.surname||canonicalCurrentName(person.first,data.variants)!==block.canonical)continue;
          const surnameWarning=block.prefix&&!norm(person.surname).startsWith(norm(block.prefix))
            ?` (проверьте фамилию в отчёте: ${block.prefix})`:'';
          if(p.child_id){const child=data.children.find(c=>String(c.child_id)===String(p.child_id));
            if(!child||canonicalCurrentName(child.registered_first_name,data.variants)!==block.canonical||block.prefix&&!norm(child.surname).startsWith(norm(block.prefix)))continue;
            if(data.profiles.filter(x=>String(x.child_id)===String(child.child_id)).some(x=>data.history.some(h=>h.phone10===x.phone10&&h.kind===source.kind&&h.report_date===source.report_date&&h.publication_id!==source.publication_id)))continue;
            candidates.push({key:`child:${child.child_id}`,label:`${child.registered_first_name} ${child.surname} — родитель ${p.parent_name||'без имени'}${surnameWarning}`,childId:String(child.child_id)});
          }else {
            if(data.history.some(h=>h.phone10===p.phone10&&h.kind===source.kind&&h.report_date===source.report_date))continue;
            candidates.push({key:`parent:${p.phone10}`,label:`${person.first} ${person.surname} — ${p.parent_name||'родитель'}${surnameWarning} (профиль пока не связан)`,phone10:String(p.phone10),firstName:person.first,surname:person.surname,generation:String(p.profile_generation||'')});
          }
        }
        const distinct=[...new Map(candidates.map(c=>[c.key,c])).values()];
        if(!distinct.length)return;
        const token=hash([source.publication_id,index,source.kind,source.report_date,source.normalized_text,owner?.record_json||owner||null,
          distinct.map(c=>[c.key,c.firstName||'',c.surname||'',c.generation||'',c.childId||'']).sort((a,b)=>a[0].localeCompare(b[0]))]);
        result.push({publicationId:source.publication_id,kind:source.kind,reportDate:source.report_date,
          blockIndex:index,heading:block.name+(block.prefix?` ${block.prefix}`:''),excerpt:block.body.join('\n').trim().slice(0,350),
          token,candidates:distinct.map(({key,label})=>({key,label}))});
      });
    }
    return result.sort((a,b)=>b.reportDate.localeCompare(a.reportDate)||a.kind.localeCompare(b.kind)||a.blockIndex-b.blockIndex);
  }
  async function list(){return sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>({ok:true,items:entries(await snapshot(tx))}));}
  async function assign({publicationId,blockIndex,token,targetKey}={}){
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(String(publicationId||''))||!Number.isSafeInteger(blockIndex)||blockIndex<0||blockIndex>999||typeof targetKey!=='string')throw new Error('Invalid historical report assignment.');
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const data=await snapshot(tx),entry=entries(data).find(x=>x.publicationId===publicationId&&x.blockIndex===blockIndex);
      if(!entry){
        const source=data.raw.find(r=>r.publication_id===publicationId),owner=data.owners.find(r=>r.owner_key===`CURRENT_BLOCK_${publicationId}_${blockIndex}`);
        let record;try{record=JSON.parse(String(owner?.record_json||''))}catch{record={};}
        const phone10=targetKey.startsWith('parent:')?targetKey.slice(7):'';
        const target=phone10?data.profiles.find(p=>String(p.phone10)===phone10):null;
        const childId=String(target?.child_id||(targetKey.startsWith('child:')?targetKey.slice(6):''));
        const histories=childId?data.history.filter(h=>String(h.child_id)===childId&&h.kind===source?.kind&&h.report_date===source?.report_date&&h.publication_id===publicationId):[];
        if(source&&record.childId===childId&&histories.length&&(!phone10||histories.some(h=>h.phone10===phone10)))return {ok:true,assigned:true,duplicate:true};
        throw new Error('Report source or roster changed. Reload history review.');
      }
      if(entry.token!==token)throw new Error('Report source or roster changed. Reload history review.');
      const selected=entry.candidates.find(c=>c.key===targetKey);if(!selected)throw new Error('Invalid child selected for report.');
      const source=data.raw.find(r=>r.publication_id===publicationId),blocks=parseCurrentStaffBlocks(source.normalized_text||'',data.variants),block=blocks[blockIndex];
      let childId='',registeredFirstName='';
      if(targetKey.startsWith('parent:')){
        const phone10=targetKey.slice(7),p=data.profiles.find(x=>String(x.phone10)===phone10);
        const person=parseCurrentParentChildName(p?.child_name);
        if(!p||p.child_id||!person?.surname||canonicalCurrentName(person.first,data.variants)!==block.canonical)throw new Error('Parent profile changed; reload history review.');
        childId='child_'+randomUUID().replace(/-/g,'');
        registeredFirstName=person.first;
        await tx.upsert`INSERT INTO children (child_id,registered_first_name,surname,created_at)
          VALUES (${childId},${person.first},${person.surname},${BigInt(now())})`;
        const [linked]=await tx`UPDATE parent_profiles SET child_id=${childId},updated_at=${BigInt(now())}
          WHERE phone10=${phone10} AND COALESCE(child_id,${''})=${''} AND profile_generation=${String(p.profile_generation||'')} RETURNING phone10`;
        if(linked.length!==1)throw new Error('Parent profile changed; reload history review.');
        await tx`UPDATE parent_registration_attempts SET child_id=${childId},updated_at=${BigInt(now())}
          WHERE attempt_id=${String(p.profile_generation||'')} AND phone10=${phone10} AND status=${'COMPLETED'}`;
      }else childId=selected.childId;
      const ownerKey=`CURRENT_BLOCK_${publicationId}_${blockIndex}`;
      const [[oldOwner]]=await tx`SELECT record_json FROM report_ownership WHERE owner_key=${ownerKey} FOR UPDATE`;
      if(oldOwner){let parsed;try{parsed=JSON.parse(String(oldOwner.record_json||''))}catch{parsed={blocked:true}}
        if(parsed.childId&&String(parsed.childId)!==childId)throw new Error('Report ownership changed; reload history review.');
        if(!parsed.childId){const value=JSON.stringify({childId,pending:false,blocked:false});
          const [updated]=await tx`UPDATE report_ownership SET record_json=${value},updated_at=${BigInt(now())} WHERE owner_key=${ownerKey} AND record_json=${oldOwner.record_json} RETURNING owner_key`;
          if(updated.length!==1)throw new Error('Report ownership changed; reload history review.');}
      }else{
        const [inserted]=await tx`INSERT INTO report_ownership (owner_key,record_json,updated_at)
          VALUES (${ownerKey},${JSON.stringify({childId,pending:false,blocked:false})},${BigInt(now())})
          ON CONFLICT (owner_key) DO NOTHING RETURNING owner_key`;
        if(inserted.length!==1)throw new Error('Report ownership changed; reload history review.');
      }
      const parents=targetKey.startsWith('parent:')?data.profiles.filter(p=>String(p.phone10)===targetKey.slice(7)):
        data.profiles.filter(p=>String(p.child_id)===childId);
      for(const p of parents){
        const prior=data.history.find(h=>h.phone10===p.phone10&&h.kind===source.kind&&h.report_date===source.report_date);
        if(prior){if(prior.publication_id===publicationId&&String(prior.child_id)===childId)continue;throw new Error('A different report already exists for this day.');}
        const text=`${data.children.find(c=>String(c.child_id)===childId)?.registered_first_name||registeredFirstName||block.name}: ${block.body.join('\n').trim()}`;
        const [inserted]=await tx`INSERT INTO parent_report_history
          (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
          VALUES (${p.phone10},${source.kind},${source.report_date},${childId},${publicationId},${BigInt(source.revision||1)},${text},${BigInt(source.submitted_at||now())})`;
        if(inserted.length!==1)throw new Error('A different report already exists for this day.');
      }
      return {ok:true,assigned:true};
    });
  }
  return {list,assign};
}
