import {fullName} from './doctors-roster.mjs';
import {validIsoDate} from './doctors-xlsx.mjs';

const SHEET='5 этаж';
const RANGE='C1:G1000';

export function decodeGreenwood(text) {
  const payload=/^\s*(?:\/\*O_o\*\/\s*)?google\.visualization\.Query\.setResponse\(([\s\S]+)\);\s*$/.exec(text)?.[1];
  if(!payload)throw new Error('Unexpected Greenwood response');
  const data=JSON.parse(payload);
  const {cols,rows}=data.table||{};
  if(data.status!=='ok' || !Array.isArray(rows) || cols?.map(col=>col.id).join(',')!=='C,G')
    throw new Error('Unexpected Greenwood columns');
  const byId=new Map();
  for(const row of rows){
    const childName=String(row.c?.[0]?.v || '').trim().replace(/\s+/gu,' ');
    const day=String(row.c?.[1]?.f || '');
    const episode=day.split('.').reverse().join('-');
    if(!childName || !validIsoDate(episode))throw new Error('Invalid Greenwood row');
    const key=fullName(childName)+'|'+episode;
    if(byId.has(key))throw new Error('Ambiguous Greenwood row');
    byId.set(key,{key,childName,episode});
  }
  return [...byId.values()];
}

export function createGreenwoodSource(env, request=fetch) {
  const id=env.DOCTORS_GREENWOOD_SHEET_ID;
  let latest=null,expires=0,reading,stale=false;
  const refresh=async()=>{
    if(!/^[\w-]+$/.test(id))throw new Error('Invalid Greenwood ID');
    const params=new URLSearchParams({sheet:SHEET,range:RANGE,headers:'1',tqx:'out:json',
      tq:'select C,G where C is not null and G is not null'});
    const response=await request('https://docs.google.com/spreadsheets/d/'+id+'/gviz/tq?'+params,{
      redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'text/plain'}
    });
    if(!response.ok)throw new Error('Greenwood unavailable');
    const body=await response.text();
    if(body.length>1024*1024)throw new Error('Oversized Greenwood response');
    latest=decodeGreenwood(body);
  };
  return {configured:Boolean(id),async read({fresh=false}={}){
    if(!id)return [];
    if(!reading && Date.now()>=expires){
      reading=refresh().then(()=>{stale=false;},()=>{
        stale=true;
        console.warn('MEDSI_DOCTORS_GREENWOOD_STALE');
      }).finally(()=>{expires=Date.now()+300000;reading=null;});
    }
    await reading;
    if(!latest || (fresh && stale))throw new Error('Greenwood unavailable');
    return latest;
  }};
}
