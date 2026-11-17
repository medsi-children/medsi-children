// Chat gallery wire representation. No schema migration or embedded binaries.
const FILE=/^s3:chat\/[A-Za-z0-9._-]{8,180}$/;
const TYPES=new Set(['image','video']);
export const GALLERY_PREFIX='gallery:';
export function parseChatGallery(input){
  const raw=String(input||'');
  if(!raw.startsWith(GALLERY_PREFIX)||raw.length>1200)return null;
  let items;
  try{items=JSON.parse(raw.slice(GALLERY_PREFIX.length))}catch{return null}
  if(!Array.isArray(items)||items.length<2||items.length>5)return null;
  const ids=new Set();
  for(const item of items){
    if(!item||typeof item!=='object'||!TYPES.has(item.type)||
      !FILE.test(String(item.fileId||''))||ids.has(item.fileId))return null;
    ids.add(item.fileId);
  }
  return items.map(item=>({fileId:item.fileId,type:item.type}));
}
export function createChatGallery(items){
  const raw=GALLERY_PREFIX+JSON.stringify(items);
  if(!parseChatGallery(raw))throw new Error('Invalid chat media group.');
  return raw;
}
