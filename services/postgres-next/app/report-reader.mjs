import {backfillRecentEducatorReports} from './source-report-backfill.mjs';
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
      return {ok:true,unlinked:!String(profile.admission_id||'')&&!String(profile.child_id||''),
        reports:rows.filter(r=>same(r.admission_id,profile.admission_id)).map(row=>({
          kind:row.kind,text:row.text||'',version:row.version||'',updatedAt:timestamp(row.updated_at)
        }))};
    });
    const first=await fetchCurrent();
    // Returning parent: retry unique admission matching before retrieving
    // previously published source blocks for this child's admission.
    if(first.unlinked)await reconcileUnlinkedRegisteredParents(sql,{phone10:phone});
    if(first.ok)await backfillRecentEducatorReports(sql,{phone10:phone});
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
