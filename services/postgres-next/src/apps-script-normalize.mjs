import {createHash} from 'node:crypto';
import {normalizeReportBaseline} from './report-baseline.mjs';
import {mergeLegacyNameRows} from '../app/name-variants-order.mjs';
import {normalizeRosterCapture} from './roster-capture.mjs';
const reject=()=>{throw new Error('Apps Script source cannot be linked unambiguously.');};
const key=v=>String(v??'').normalize('NFC').trim().toLocaleLowerCase('ru').replace(/ё/g,'е');
const ms=v=>{if(!/^[1-9]\d{0,15}$/.test(String(v))||!Number.isSafeInteger(Number(v)))reject();return String(v);};
// REPORTS provides child spelling only after an exact opaque admission join to
// authoritative D1. It never creates parents or overwrites profile generations.
export function normalizeAppsScriptSource(source,tables){
  const p=source?.properties,s=source?.sheets;
  if(!p||!s||!Array.isArray(tables?.chat_profiles)||!Array.isArray(tables.report_publication_state))reject();
  const values=s.REPORTS?.values;
  if(!Array.isArray(values)||values[0]?.[7]!=='ID поступления (служебный)'||
     values[0]?.[8]!=='Поколение профиля (служебный)')reject();
  const byAdmission=new Map();
  for(const row of values.slice(1)){
    const id=String(row[7]??'').trim();if(!id)continue;
    const old=byAdmission.get(id);
    if(old&&(key(old[2])!==key(row[2])||key(old[3])!==key(row[3])))reject();
    byAdmission.set(id,row);
  }
  const children=[],admissions=[],seen=new Set();
  for(const profile of tables.chat_profiles){
    if(!profile.child_admission_id)continue;
    const row=byAdmission.get(profile.child_admission_id);
    if(!row||key(profile.child_name)!==key(String(row[2]).trim()+' '+String(row[3]).trim()))reject();
    if(seen.has(profile.child_admission_id))continue;
    seen.add(profile.child_admission_id);
    const child_id='legacy-child:'+createHash('sha256').update(profile.child_admission_id).digest('hex');
    children.push({child_id,registered_first_name:String(row[2]).trim(),surname:String(row[3]).trim(),created_at:null});
    admissions.push({admission_id:profile.child_admission_id,child_id,status:'active',admitted_at:null,discharged_at:null});
  }
  const raw=[],heads=[];
  for(const head of tables.report_publication_state){
    if(!['morning','evening','psychology'].includes(head.kind))reject();
    const value=s[head.kind.toUpperCase()]?.values?.[0]?.[0];
    if(typeof value!=='string'||!value.trim())reject();
    const submitted_at=ms(p['RAW_REPORT_PUBLICATION_AT_'+head.kind]);
    if(BigInt(submitted_at)>BigInt(ms(head.updated_at)))reject();
    const report_date=p['REPORT_CURRENT_D1_PUBLICATION_DATE_'+head.kind.toUpperCase()]||
      new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Number(submitted_at)));
    raw.push({publication_id:head.publication_id,kind:head.kind,report_date,
      raw_text:value,normalized_text:value,author_id:'legacy:unknown',submitted_at,revision:String(head.revision)});
    heads.push({publication_id:head.publication_id,kind:head.kind,submitted_at,revision:String(head.revision)});
  }
  const ownership=[];
  for(const [owner_key,record_json] of Object.entries(p))if(owner_key.startsWith('RAW_REPORT_OWNER_')){
    let record;try{record=JSON.parse(record_json);}catch{reject();}
    ownership.push({owner_key,record_json,updated_at:ms(record.at)});
  }
  const nameRows=s.NAME_VARIANTS?.values;
  if(nameRows?.[0]?.[0]!=='MAIN_NAME'||nameRows?.[0]?.[1]!=='NAME_VARIANTS')reject();
  const mergedNames=mergeLegacyNameRows(nameRows.slice(1));
  const reportBaseline={nameRows:mergedNames,legacyNameVariantOrder:mergedNames.map(row=>key(row[0])),raw,heads,submissions:[],ownership};
  normalizeReportBaseline(reportBaseline);
  return {roster:normalizeRosterCapture(children,admissions),reportBaseline,
    legacyProperties:{...p},preliminary:source.preliminary===true};
}
