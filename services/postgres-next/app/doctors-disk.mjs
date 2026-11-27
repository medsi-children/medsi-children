import {createHash} from 'node:crypto';

const API = 'https://cloud-api.yandex.net/v1/disk/resources';
const FILE_LIMIT = 16*1024*1024;
export const isPlan = item => item.type==='file' && /план/iu.test(item.name) &&
  /\.xlsx$/iu.test(item.name) && !item.name.startsWith('~$');
// Fixed sandbox namespace, not an arbitrary path relabelled as a test root.
export const DOCTORS_TEST_ROOT='disk:/medsi-doctors-test';
const safeSegment=name=>typeof name==='string' && name.length>0 && name!=='.' && name!=='..' &&
  !/[\/\\\x00-\x1f\x7f]/u.test(name);
export function validDiskRoot(path){
  return typeof path==='string' && path.startsWith('disk:/') &&
    (path==='disk:/' || path.slice(6).split('/').every(safeSegment));
}
export function directDiskChild(parent,item){
  return validDiskRoot(parent) && safeSegment(item?.name) && item.path===parent+(parent==='disk:/'?'':'/')+item.name;
}
export const diskVersion = item => {
  const sha=String(item?.sha256||'').toLowerCase(),md5=String(item?.md5||'').toLowerCase();
  return /^[a-f0-9]{64}$/.test(sha)?sha:/^[a-f0-9]{32}$/.test(md5)?md5:'';
};
export function verifyDiskBytes(bytes,version){
  const algorithm=/^[a-f0-9]{64}$/.test(version)?'sha256':/^[a-f0-9]{32}$/.test(version)?'md5':null;
  return Boolean(algorithm && Buffer.isBuffer(bytes) && createHash(algorithm).update(bytes).digest('hex')===version);
}
export function testDiskWriteEnabled(env,storage){
  return env.DOCTORS_DISK_TEST_WRITE==='1' && env.DOCTORS_DISK_ROOT===DOCTORS_TEST_ROOT &&
    env.DOCTORS_DISK_WRITE_TEST_ROOT===DOCTORS_TEST_ROOT && storage?.configured===true;
}

// Production writes are opt-in and tied to an explicit rollout generation.
// A new generation/account/root cannot silently replay old pending changes.
export function diskWritePolicy(env,storage){
  const root=env.DOCTORS_DISK_ROOT;
  if(env.DOCTORS_DISK_WRITE_ENABLED==='1'){
    if(env.DOCTORS_DISK_TEST_WRITE==='1' || !validDiskRoot(root) || root===DOCTORS_TEST_ROOT ||
      !env.DOCTORS_GREENWOOD_SHEET_ID || !env.DOCTORS_DISK_TOKEN ||
      env.DOCTORS_DISK_CONCURRENT_EDIT_ACK!=='1' ||
      !/^[A-Za-z0-9_-]{12,128}$/.test(env.DOCTORS_DISK_WRITE_EPOCH||'') ||
      storage?.configured!==true)return null;
    const scope=createHash('sha256').update(JSON.stringify(['production',root,env.DOCTORS_DISK_TOKEN,
      env.DOCTORS_GREENWOOD_SHEET_ID,env.DOCTORS_DISK_WRITE_EPOCH])).digest('hex');
    return {mode:'production',root,scope};
  }
  if(testDiskWriteEnabled(env,storage))return {mode:'test',root,scope:'test:'+root};
  return null;
}
export function allowedPlanWritePath(root,path){
  if(!validDiskRoot(root) || !validDiskRoot(path))return false;
  const prefix=root==='disk:/'?root:root+'/';
  if(!path.startsWith(prefix))return false;
  const segments=path.slice(prefix.length).split('/');
  return segments.length===2 && segments[0]!=='medsi-doctors-test' &&
    isPlan({type:'file',name:segments[1]});
}

const transferError=code=>Object.assign(new Error(code),{doctorDiskCode:code});
const safeTransferUrl=value=>{
  let url;
  try{url=new URL(value);}catch{throw transferError('invalidTransferUrl');}
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') ||
    !/(?:^|\.)(?:yandex\.(?:net|ru|com)|yandexdisk\.net)$/iu.test(url.hostname))
    throw transferError('unexpectedTransferHost');
  return url;
};
const httpCode=status=>status===401||status===403?'denied':status===404?'notFound':status===429?'rateLimited':status>=500?'serverError':'httpError';
async function bodyBytes(response) {
  if (!response.ok || !response.body) throw transferError('download_'+httpCode(response.status));
  const chunks=[];
  let size=0;
  for await (const chunk of response.body) {
    size+=chunk.length;
    if(size>FILE_LIMIT)throw transferError('fileTooLarge');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

// Same depth bound for discovery and the smart writer. The legacy writer
// keeps its original direct-child-only scope.
export const MAX_PLAN_SUBFOLDER_DEPTH=6;
export const excludedPlanSegment=name=>name.toLowerCase()==='medsi-doctors-test'||/образец|шаблон/iu.test(name);
export function allowedSmartPlanWritePath(root,path){
  if(!validDiskRoot(root)||!validDiskRoot(path))return false;
  const prefix=root==='disk:/'?root:root+'/';
  if(!path.startsWith(prefix))return false;
  const segments=path.slice(prefix.length).split('/');
  return segments.length<=MAX_PLAN_SUBFOLDER_DEPTH+2 &&
    segments.every(name=>safeSegment(name)&&!excludedPlanSegment(name))&&
    isPlan({type:'file',name:segments.at(-1)});
}
export function createDoctorsDisk(token, request=fetch, {writeRoot=null,allowRootPlans=false}={}) {
  async function api(endpoint, params) {
    let response;
    try{response=await request(API+endpoint+'?'+new URLSearchParams(params),{
      headers:{Authorization:'OAuth '+token},redirect:'error',signal:AbortSignal.timeout(10000)
    });}catch{throw transferError('apiNetwork');}
    if(!response.ok)throw transferError('api_'+httpCode(response.status));
    try{return await response.json();}catch{throw transferError('apiInvalidJson');}
  }
  async function link(endpoint,params) {
    const {href}=await api(endpoint,params);
    return safeTransferUrl(href);
  }
  return {
    async list(path) {
      const all=[];
      for(let offset=0;offset<10000;offset+=100){
        const page=await api('',{path,offset,limit:100});
        const items=page._embedded?.items;
        if(!Array.isArray(items))throw transferError('invalidListing');
        all.push(...items);
        if(items.length<100)return all;
      }
      throw transferError('directoryLimit');
    },
    stat:path=>api('',{path}),
    async download(path){
      let url=await link('/download',{path});
      const signal=AbortSignal.timeout(30000);
      for(let hop=0;hop<=3;hop++){
        let response;
        try{response=await request(url,{redirect:'manual',signal});}
        catch{throw transferError('downloadNetwork');}
        if([301,302,303,307,308].includes(response.status)){
          const location=response.headers.get('location');
          await response.body?.cancel();
          if(!location || hop===3)throw transferError('downloadRedirectLimit');
          url=safeTransferUrl(new URL(location,url).href);
          continue;
        }
        try{return await bodyBytes(response);}
        catch(error){if(error.doctorDiskCode)throw error;throw transferError('downloadBody');}
      }
      throw transferError('downloadRedirectLimit');
    },
    async upload(path,bytes){
      if(!(allowRootPlans?allowedSmartPlanWritePath(writeRoot,path):allowedPlanWritePath(writeRoot,path)))throw new Error('Disk upload outside authorized plan root');
      const url=await link('/upload',{path,overwrite:'true'});
      const response=await request(url,{method:'PUT',body:bytes,redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!response.ok)throw new Error('Disk upload failed');
    }
  };
}
