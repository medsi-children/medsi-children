import {backfillRecentEducatorReports} from './source-report-backfill.mjs';
import {createHash} from 'node:crypto';
import {reconcileUnlinkedRegisteredParents} from './parent-admission-matching.mjs';
const PHONE=/^\d{10}$/;
const KINDS=new Set(['morning','evening','psychology']);
const timestamp=v=>Number(v||0);
const same=(a,b)=>String(a||'')===String(b||'');

export function createReportReader(sql) {
  if (!sql?.begin)throw new Error('PostgreSQL query client required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  function activePhone(phone) {
    if(!PHONE.test(String(phone||'')))throw new Error('Invalid parent phone.');
    return phone;
  }
  async function current(phoneRaw){
    const phone=activePhone(phoneRaw);
    const fetchCurrent=()=>read(async tx=>{
      const [[profile]]=await tx`SELECT admission_id,child_id FROM parent_profiles WHERE phone10=${phone}`;
      if(!profile)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const [rows]=await tx`SELECT kind,text,version,updated_at,admission_id
        FROM parent_current_reports WHERE phone10=${phone}`;
      const reports=rows.filter(r=>same(r.admission_id,profile.admission_id)).map(row=>({
        kind:row.kind,text:row.text||'',version:row.version||'',updatedAt:timestamp(row.updated_at)
      }));
      // Group therapy is shared with every currently registered, authenticated
      // parent. It is not child-specific: always serve the most recent
      // publication directly, including parents who registered afterward.
      // The router verifies the parent's own session and phone first.
      const [[head]]=await tx`SELECT publication_id FROM report_publication_head
        WHERE kind=${'psychology'}`;
      if(head?.publication_id){
        const [[published]]=await tx`SELECT normalized_text,submitted_at FROM raw_reports
          WHERE publication_id=${head.publication_id} AND kind=${'psychology'}`;
        const text=String(published?.normalized_text||'');
        if(text.trim()){
          const version=createHash('sha256')
            .update('psychology'+'\u0000'+String(profile.admission_id||'')+'\u0000'+text,'utf8')
            .digest('hex');
          const index=reports.findIndex(r=>r.kind==='psychology');
          if(index>=0)reports.splice(index,1);
          reports.push({kind:'psychology',text,version,updatedAt:timestamp(published.submitted_at)});
        }
      }
      return {ok:true,unlinked:!String(profile.admission_id||'')&&!String(profile.child_id||''),
        reports};
    });
    const first=await fetchCurrent();
    // Returning parent: retry unique admission matching before retrieving
    // previously published source blocks for this child's admission.
    // Recovery is opportunistic. A failure in child/admission matching or
    // morning/evening backfill must never hide the current shared group
    // therapy (or other already published, verified parent reports).
    if(first.unlinked){
      try{await reconcileUnlinkedRegisteredParents(sql,{phone10:phone})}catch(_){}
    }
    if(first.ok){
      try{await backfillRecentEducatorReports(sql,{phone10:phone})}catch(_){}
    }
    return fetchCurrent();
  }
  async function history(phoneRaw){
    const phone=activePhone(phoneRaw);
    return read(async tx=>{
      const [[profile]]=await tx`SELECT admission_id FROM parent_profiles WHERE phone10=${phone}`;
      if(!profile)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const [rows]=await tx`SELECT kind,report_date,text,captured_at,admission_id
        FROM parent_report_history WHERE phone10=${phone}`;
      const order={morning:0,psychology:1,evening:2};
      return {ok:true,reports:rows
        .filter(r=>same(r.admission_id,profile.admission_id))
        .sort((a,b)=>String(b.report_date).localeCompare(String(a.report_date)) || (order[a.kind]??9)-(order[b.kind]??9))
        .slice(0,180).map(r=>({
          kind:r.kind,reportDate:r.report_date,text:r.text||'',capturedAt:timestamp(r.captured_at)
        }))};
    });
  }
  async function unread(phoneRaw){
    const phone=activePhone(phoneRaw);
    return read(async tx=>{
      const [[profile]]=await tx`SELECT admission_id FROM parent_profiles WHERE phone10=${phone}`;
      if(!profile)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const [rows]=await tx`SELECT kind,version,read_version,admission_id
        FROM parent_current_reports WHERE phone10=${phone}`;
      const reportUnread={morning:false,evening:false,psychology:false};
      for(const r of rows)if(KINDS.has(r.kind)&&same(r.admission_id,profile.admission_id)){
        reportUnread[r.kind]=Boolean(r.version)&&!same(r.version,r.read_version);
      }
      return {ok:true,reportUnread};
    });
  }
  async function markRead(phoneRaw,kind,version){
    const phone=activePhone(phoneRaw);
    if(!KINDS.has(kind)||!version||String(version).length>180)throw new Error('Invalid report version.');
    return write(async tx=>{
      const [[profile]]=await tx`SELECT admission_id FROM parent_profiles WHERE phone10=${phone}`;
      if(!profile)throw new Error('Inactive profile.');
      const [[current]]=await tx`SELECT version,read_version,admission_id
        FROM parent_current_reports WHERE phone10=${phone} AND kind=${kind}`;
      if(!current||!same(current.admission_id,profile.admission_id)||
         !same(current.version,version))return {ok:true,skipped:true};
      if(same(current.read_version,version))return {ok:true,skipped:true};
      await tx`UPDATE parent_current_reports SET read_version=${String(version)}
        WHERE phone10=${phone} AND kind=${kind}`;
      return {ok:true,skipped:false};
    });
  }
  async function profile(phoneRaw){
    const phone=activePhone(phoneRaw);
    return read(async tx=>{
      const [[row]]=await tx`SELECT phone10,parent_name,child_name,child_id
        FROM parent_profiles WHERE phone10=${phone}`;
      if(!row)return {ok:false,code:'CHAT_CLOSED',message:'Чат недоступен'};
      const [[child]]=await tx`SELECT registered_first_name,surname
        FROM children WHERE child_id=${row.child_id}`;
      return {ok:true,phone,parentName:row.parent_name||'',
        childName:row.child_name||[child?.registered_first_name,child?.surname].filter(Boolean).join(' ')};
    });
  }
  return {current,history,unread,markRead,profile};
}
