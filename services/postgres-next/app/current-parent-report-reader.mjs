import {createCurrentChildLinkStore} from './current-child-link-store.mjs';
import {createCurrentReportBackfill} from './current-report-backfill.mjs';
import {currentReportVersion} from './current-report-plan.mjs';
import {normalizeCurrentReportPunctuation} from './current-report-punctuation.mjs';
const PHONE=/^\d{10}$/;
const CHILD_KINDS=new Set(['morning','evening']);
const KINDS=new Set(['morning','evening','psychology']);
const same=(a,b)=>String(a||'')===String(b||'');
const phone=v=>{if(!PHONE.test(String(v||'')))throw new Error('Invalid parent phone.');return String(v)};
const stamp=v=>Number(v||0);
// Drop-in report reader API. A registered parent's own child_id is the ONLY
// individual-report access boundary. No hospital admission is consulted.
export function createCurrentParentReportReader(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  const link=createCurrentChildLinkStore(sql,{now});
  const backfill=createCurrentReportBackfill(sql,{now});
  async function verifiedChild(tx,profile){
    const id=String(profile?.child_id||'');
    if(!id)return '';
    const [[child]]=await tx`SELECT child_id FROM children WHERE child_id=${id}`;
    return child&&same(child.child_id,id)?id:'';
  }
  async function latestTherapy(tx){
    const [[publication]]=await tx`SELECT r.publication_id,r.normalized_text,r.submitted_at
      FROM report_publication_head h
      INNER JOIN raw_reports r ON r.publication_id=h.publication_id
      WHERE h.kind=${'psychology'} AND r.kind=${'psychology'}`;
    if(!publication||!String(publication.normalized_text||'').trim())return null;
    const storedText=String(publication.normalized_text);
    const text=normalizeCurrentReportPunctuation(storedText);
    return {kind:'psychology',text,
      publicationId:publication.publication_id,
      version:currentReportVersion({kind:'psychology',text:storedText,publicationId:publication.publication_id}),
      updatedAt:stamp(publication.submitted_at)};
  }
  async function current(phoneRaw){
    const p=phone(phoneRaw);
    // Failed matching/backfill never hides shared therapy.
    try{await link.reconcile({phone10:p})}catch(_){}
    try{await backfill.recover({phone10:p})}catch(_){}
    // Opening the default report screen also repairs history for parents
    // who registered after staff published earlier days.
    try{await backfill.recoverHistory({phone10:p})}catch(_){}
    return read(async tx=>{
      const [[profile]]=await tx`SELECT child_id FROM parent_profiles WHERE phone10=${p}`;
      if(!profile)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const childId=await verifiedChild(tx,profile);
      const [[rows],[heads]]=await Promise.all([
        tx`SELECT kind,text,version,updated_at,publication_id,child_id
          FROM parent_current_reports WHERE phone10=${p}`,
        tx`SELECT kind,publication_id FROM report_publication_head
          WHERE kind IN (${'morning'},${'evening'})`
      ]);
      const headByKind=new Map(heads.map(x=>[x.kind,x.publication_id]));
      const reports=rows.filter(row=>CHILD_KINDS.has(row.kind)&&childId&&
        same(row.child_id,childId)&&same(row.publication_id,headByKind.get(row.kind)))
        .map(row=>({kind:row.kind,text:normalizeCurrentReportPunctuation(row.text||''),version:row.version||'',
          updatedAt:stamp(row.updated_at)}));
      const therapy=await latestTherapy(tx);
      if(therapy)reports.push({kind:therapy.kind,text:therapy.text,
        version:therapy.version,updatedAt:therapy.updatedAt});
      return {ok:true,unlinked:!childId,reports};
    });
  }
  async function history(phoneRaw){
    const p=phone(phoneRaw);
    // A parent can open history before ever opening today's report.
    // Identity and missing-day recovery are best-effort; a failed repair
    // must never erase or hide previously saved reports.
    try{await link.reconcile({phone10:p})}catch(_){}
    try{await backfill.recover({phone10:p})}catch(_){}
    try{await backfill.recoverHistory({phone10:p})}catch(_){}
    return read(async tx=>{
      const [[profile]]=await tx`SELECT child_id FROM parent_profiles WHERE phone10=${p}`;
      if(!profile)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const childId=await verifiedChild(tx,profile);
      const [rows]=await tx`SELECT kind,report_date,text,captured_at,child_id
        FROM parent_report_history WHERE phone10=${p}`;
      const order={morning:0,psychology:1,evening:2};
      return {ok:true,reports:rows.filter(r=>(r.kind==='psychology')||
          childId&&CHILD_KINDS.has(r.kind)&&same(r.child_id,childId))
        .sort((a,b)=>String(b.report_date).localeCompare(String(a.report_date))||
          (order[a.kind]??9)-(order[b.kind]??9)).slice(0,180)
        .map(r=>({kind:r.kind,reportDate:r.report_date,text:normalizeCurrentReportPunctuation(r.text||''),
          capturedAt:stamp(r.captured_at)}))};
    });
  }
  async function unread(phoneRaw){
    const p=phone(phoneRaw);
    return read(async tx=>{
      const [[profile]]=await tx`SELECT child_id FROM parent_profiles WHERE phone10=${p}`;
      if(!profile)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const childId=await verifiedChild(tx,profile);
      const [[rows],[heads]]=await Promise.all([
        tx`SELECT kind,version,read_version,child_id,publication_id
          FROM parent_current_reports WHERE phone10=${p}`,
        tx`SELECT kind,publication_id FROM report_publication_head
          WHERE kind IN (${'morning'},${'evening'})`
      ]);
      const headsByKind=new Map(heads.map(x=>[x.kind,x.publication_id]));
      const reportUnread={morning:false,evening:false,psychology:false};
      for(const row of rows)if(CHILD_KINDS.has(row.kind)&&childId&&
          same(row.child_id,childId)&&same(row.publication_id,headsByKind.get(row.kind)))
        reportUnread[row.kind]=Boolean(row.version)&&!same(row.version,row.read_version);
      const therapy=await latestTherapy(tx);
      const seen=rows.find(r=>r.kind==='psychology');
      if(therapy)reportUnread.psychology=!same(seen?.read_version,therapy.version);
      return {ok:true,reportUnread};
    });
  }
  async function markRead(phoneRaw,kind,version){
    const p=phone(phoneRaw);
    if(!KINDS.has(kind)||!version||String(version).length>180)throw new Error('Invalid report version.');
    return write(async tx=>{
      const [[profile]]=await tx`SELECT child_id FROM parent_profiles WHERE phone10=${p}`;
      if(!profile)throw new Error('Inactive profile.');
      if(kind==='psychology'){
        const shared=await latestTherapy(tx);
        if(!shared||!same(version,shared.version))return {ok:true,skipped:true};
        const [[existing]]=await tx`SELECT read_version FROM parent_current_reports
          WHERE phone10=${p} AND kind=${kind}`;
        if(same(existing?.read_version,version))return {ok:true,skipped:true};
        await tx.upsert`INSERT INTO parent_current_reports
          (phone10,kind,child_id,publication_id,revision,text,version,read_version,updated_at)
          VALUES (${p},${kind},${''},${shared.publicationId},${0n},${shared.text},
            ${version},${version},${BigInt(shared.updatedAt)})`;
        return {ok:true,skipped:false};
      }
      const childId=await verifiedChild(tx,profile);
      if(!childId)return {ok:true,skipped:true};
      const [[head]]=await tx`SELECT publication_id FROM report_publication_head WHERE kind=${kind}`;
      const [[entry]]=await tx`SELECT child_id,publication_id,version,read_version
        FROM parent_current_reports WHERE phone10=${p} AND kind=${kind}`;
      if(!entry||!same(entry.child_id,childId)||
        !same(entry.publication_id,head?.publication_id)||!same(entry.version,version))
        return {ok:true,skipped:true};
      if(same(entry.read_version,version))return {ok:true,skipped:true};
      await tx`UPDATE parent_current_reports SET read_version=${String(version)}
        WHERE phone10=${p} AND kind=${kind} AND child_id=${childId}
          AND version=${String(version)}`;
      return {ok:true,skipped:false};
    });
  }
  async function profile(phoneRaw){
    const p=phone(phoneRaw);
    return read(async tx=>{
      const [[row]]=await tx`SELECT phone10,parent_name,child_name,child_id
        FROM parent_profiles WHERE phone10=${p}`;
      if(!row)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const [[child]]=await tx`SELECT registered_first_name,surname
        FROM children WHERE child_id=${String(row.child_id||'')}`;
      return {ok:true,phone:p,parentName:row.parent_name||'',
        childName:row.child_name||[child?.registered_first_name,child?.surname].filter(Boolean).join(' ')};
    });
  }
  return {current,history,unread,markRead,profile};
}
