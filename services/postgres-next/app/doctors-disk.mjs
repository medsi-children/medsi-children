const API = 'https://cloud-api.yandex.net/v1/disk/resources';
const FILE_LIMIT = 16*1024*1024;
export const isPlan = item => item.type==='file' && /план/iu.test(item.name) &&
  /\.xlsx$/iu.test(item.name) && !item.name.startsWith('~$');
export const diskVersion = item => item.sha256 || item.md5 || '';

async function bodyBytes(response) {
  if (!response.ok || !response.body) throw new Error('Disk download failed');
  const chunks=[];
  let size=0;
  for await (const chunk of response.body) {
    size+=chunk.length;
    if(size>FILE_LIMIT)throw new Error('Disk file exceeds size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

export function createDoctorsDisk(token, request=fetch) {
  async function api(endpoint, params) {
    const response=await request(API+endpoint+'?'+new URLSearchParams(params),{
      headers:{Authorization:'OAuth '+token},redirect:'error',signal:AbortSignal.timeout(10000)
    });
    if(!response.ok)throw new Error('Disk API unavailable');
    return response.json();
  }
  async function link(endpoint,params) {
    const {href}=await api(endpoint,params);
    const url=new URL(href);
    if(url.protocol!=='https:' || url.username || url.password ||
      !/(?:^|\.)(?:yandex\.(?:net|ru|com)|yandexdisk\.net)$/iu.test(url.hostname))
      throw new Error('Unexpected Disk transfer host');
    return url;
  }
  return {
    async list(path) {
      const all=[];
      for(let offset=0;offset<10000;offset+=100){
        const page=await api('',{path,offset,limit:100});
        const items=page._embedded?.items;
        if(!Array.isArray(items))throw new Error('Invalid Disk listing');
        all.push(...items);
        if(items.length<100)return all;
      }
      throw new Error('Disk directory exceeds supported limit');
    },
    stat:path=>api('',{path}),
    async download(path){
      const url=await link('/download',{path});
      return bodyBytes(await request(url,{redirect:'error',signal:AbortSignal.timeout(15000)}));
    },
    async upload(path,bytes){
      const url=await link('/upload',{path,overwrite:'true'});
      const response=await request(url,{method:'PUT',body:bytes,redirect:'error',signal:AbortSignal.timeout(15000)});
      if (!response.ok)throw new Error('Disk upload failed');
    }
  };
}
