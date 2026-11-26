import {fullName} from './doctors-roster.mjs';
import {validIsoDate} from './doctors-xlsx.mjs';

const SHEET='5 этаж';
const RANGE='C1:G1000';
const ROSTER_CACHE_MS=25000;

// Only the explicitly configured discharge column may be projected.
const dischargeColumn=value=>{
  const column=String(value||'').trim().toUpperCase();
  if(column && (!/^[A-Z]$/.test(column) || ['C','G'].includes(column)))
    throw new Error('Invalid Greenwood discharge column');
  return column;
};
function sheetDate(cell){
  if(cell==null || (cell.v==null && !cell.f))return null;
  const formatted=String(cell.f||cell.v||'').trim();
  const match=/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(formatted);
  const iso=match ? [match[3],match[2].padStart(2,'0'),match[1].padStart(2,'0')].join('-') : formatted;
  if(validIsoDate(iso))return iso;
  const raw=/^Date\((\d{4}),(\d{1,2}),(\d{1,2})\)$/.exec(String(cell.v||''));
  if(raw){
    if(Number(raw[2])>11)return null;
    const value=[raw[1],String(Number(raw[2])+1).padStart(2,'0'),raw[3].padStart(2,'0')].join('-');
    if(validIsoDate(value))return value;
  }
  return null;
}
export function decodeGreenwood(text, configuredColumn='') {
  const column=dischargeColumn(configuredColumn);
  const columns=['C','G',...(column?[column]:[])];
  const payload=/^\s*(?:\/\*O_o\*\/\s*)?google\.visualization\.Query\.setResponse\(([\s\S]+)\);\s*$/.exec(text)?.[1];
  if(!payload)throw new Error('Unexpected Greenwood response');
  const data=JSON.parse(payload);
  const {cols,rows}=data.table||{};
  if(data.status!=='ok' || !Array.isArray(rows) || cols?.map(col=>col.id).join(',')!==columns.join(','))
    throw new Error('Unexpected Greenwood columns');
  const byId=new Map();
  for(const row of rows){
    const childName=String(row.c?.[0]?.v || '').trim().replace(/\s+/gu,' ');
    const episode=sheetDate(row.c?.[1]);
    const discharge=column ? sheetDate(row.c?.[2]) : null;
    if(!childName)throw new Error('Invalid Greenwood row');
    const key=fullName(childName)+'|'+(episode||'undated');
    if(byId.has(key))throw new Error('Ambiguous Greenwood row');
    byId.set(key,{key,childName,episode,discharge:episode && discharge>=episode ? discharge : null});
  }
  return [...byId.values()];
}

export function createGreenwoodSource(env, request=fetch, now=Date.now) {
  const id=env.DOCTORS_GREENWOOD_SHEET_ID;
  let latest=null,expires=0,reading,stale=false;
  const refresh=async()=>{
    if(!/^[\w-]+$/.test(id))throw new Error('Invalid Greenwood ID');
    const column=dischargeColumn(env.DOCTORS_GREENWOOD_DISCHARGE_COLUMN);
    const params=new URLSearchParams({sheet:SHEET,range:column?'A1:Z1000':RANGE,headers:'1',tqx:'out:json',
      tq:'select C,G'+(column?','+column:'')+' where C is not null'});
    const response=await request('https://docs.google.com/spreadsheets/d/'+id+'/gviz/tq?'+params,{
      redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'text/plain'}
    });
    if(!response.ok)throw new Error('Greenwood unavailable');
    const body=await response.text();
    if(body.length>1024*1024)throw new Error('Oversized Greenwood response');
    latest=decodeGreenwood(body,column);
  };
  return {configured:Boolean(id),async read({fresh=false,refresh:force=false}={}){
    if(!id)return [];
    if(!reading && (fresh || force || now()>=expires)){
      reading=refresh().then(()=>{stale=false;},()=>{
        stale=true;
        console.warn('MEDSI_DOCTORS_GREENWOOD_STALE');
      }).finally(()=>{expires=now()+ROSTER_CACHE_MS;reading=null;});
    }
    await reading;
    if(!latest || (fresh && stale))throw new Error('Greenwood unavailable');
    return latest;
  }};
}
