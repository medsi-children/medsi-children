import sharp from 'sharp';

// Process-local only. Access is checked before every cache lookup.
export function createMediaPreviews(){
  const cache=new Map(),pending=new Map();
  let bytes=0;
  const maxBytes=24*1024*1024,maxInput=25*1024*1024;
  let active=0;const waiting=[];
  async function render(load){
    await new Promise(resolve=>{if(active<2){active++;resolve();}else waiting.push(resolve);});
    try{
      const object=await load(AbortSignal.timeout(20000));
      try{
      if(!String(object.ContentType||'').startsWith('image/'))throw new Error('Preview requires image.');
      if(Number(object.ContentLength)>maxInput)throw new Error('Preview source too large.');
      const chunks=[];let size=0;
      if(object.Body?.[Symbol.asyncIterator]){
        try{
          for await(const chunk of object.Body){
            size+=chunk.length;
            if(size>maxInput)throw new Error('Preview source too large.');
            chunks.push(Buffer.from(chunk));
          }
        }finally{object.Body.destroy?.();}
      }else{
        const buffer=Buffer.from(await object.Body.transformToByteArray());
        if(buffer.length>maxInput)throw new Error('Preview source too large.');
        chunks.push(buffer);
      }
      return await sharp(Buffer.concat(chunks),{limitInputPixels:40000000})
        .rotate().resize({width:640,height:640,fit:'inside',withoutEnlargement:true})
        .jpeg({quality:76}).toBuffer();
      }finally{object.Body?.destroy?.();}
    }finally{const next=waiting.shift();if(next)next();else active--;}
  }
  return async function preview(key,load){
    const saved=cache.get(key);
    if(saved&&saved.expires>Date.now())return saved.buffer;
    if(saved){cache.delete(key);bytes-=saved.buffer.length;}
    if(pending.has(key))return pending.get(key);
    // Limit original downloads and image decodes on the 1 GB app instance.
    if(pending.size>=20)throw new Error('Preview busy.');
    const task=render(load).then(buffer=>{
      while(cache.size&&(bytes+buffer.length>maxBytes||cache.size>=128)){
        const oldest=cache.keys().next().value;
        bytes-=cache.get(oldest).buffer.length;cache.delete(oldest);
      }
      if(buffer.length<=maxBytes){cache.set(key,{buffer,expires:Date.now()+300000});bytes+=buffer.length;}
      return buffer;
    }).finally(()=>pending.delete(key));
    pending.set(key,task);return task;
  };
}
