import {createHash} from 'node:crypto';

const ru=value=>String(value||'').normalize('NFC').trim().toLocaleLowerCase('ru').replace(/ё/g,'е');
function cleanWord(value) {
  const name=String(value||'').trim().normalize('NFC');
  if(!/^[А-ЯЁа-яё]+(?:-[А-ЯЁа-яё]+)*$/u.test(name)||name.length>80)throw new Error('Укажите одно русское имя.');
  return name;
}

export function normalizeVariantRow(input) {
  const preferredName=cleanWord(input?.preferredName);
  const source=Array.isArray(input?.variants)?input.variants:String(input?.variants||'').split(/[,;\n]/);
  if(source.length>40)throw new Error('Too many name variants.');
  const byKey=new Map();
  byKey.set(ru(preferredName),preferredName);
  for(const raw of source) {
    const v=cleanWord(raw);
    byKey.set(ru(v),v);
  }
  return {baseKey:ru(preferredName),preferredName,variants:[...byKey.values()]};
}

const revision=rows=>createHash('sha256').update(JSON.stringify(rows.map(r=>[r.base_key,r.preferred_name,r.variants_json]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');

export function createNameVariantsStore(sql) {
  if(!sql?.begin)throw new Error('PostgreSQL query client required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  const list=async()=>read(async tx=>{
    const [rows]=await tx`SELECT base_key,preferred_name,variants_json,updated_at FROM name_variants`;
    return {ok:true,revision:revision(rows),items:rows.map(r=>({
      baseKey:r.base_key,preferredName:r.preferred_name,
      variants:JSON.parse(r.variants_json||'[]'),updatedAt:Number(r.updated_at||0)
    })).sort((a,b)=>a.preferredName.localeCompare(b.preferredName,'ru'))};
  });
  async function save(input) {
    const row=normalizeVariantRow(input);
    const previousBaseKey=String(input?.previousBaseKey || row.baseKey);
    if(!previousBaseKey || previousBaseKey.length>80)throw new Error('Invalid previous key.');
    return write(async tx=>{
      const [all]=await tx`SELECT base_key,preferred_name,variants_json FROM name_variants`;
      const occupied=new Map();
      for(const item of all) {
        if(item.base_key===previousBaseKey)continue;
        for(const name of JSON.parse(item.variants_json||'[]'))occupied.set(ru(name),item.base_key);
        occupied.set(ru(item.preferred_name),item.base_key);
      }
      for(const name of row.variants) {
        const owner=occupied.get(ru(name));
        if(owner)throw new Error('Вариант имени уже принадлежит другой группе.');
      }
      if(previousBaseKey!==row.baseKey) {
        await tx`DELETE FROM name_variants WHERE base_key=${previousBaseKey}`;
      }
      await tx.upsert`INSERT INTO name_variants (base_key,preferred_name,variants_json,updated_at)
        VALUES (${row.baseKey},${row.preferredName},${JSON.stringify(row.variants)},${BigInt(Date.now())})`;
      return {ok:true,baseKey:row.baseKey};
    });
  }
  async function remove(baseKey){
    const key=String(baseKey||'');
    if(!/^[а-яё-]{1,80}$/u.test(key))throw new Error('Invalid name key.');
    return write(async tx=>{
      await tx`DELETE FROM name_variants WHERE base_key=${key}`;
      return {ok:true};
    });
  }
  async function replaceAll(input){
    if(!Array.isArray(input?.items)||input.items.length>500||typeof input.revision!=='string')throw new Error('Invalid name list.');
    const normalized=input.items.map(item=>({...normalizeVariantRow(item),previousBaseKey:String(item.previousBaseKey||'')}));
    if(new Set(normalized.map(r=>r.baseKey)).size!==normalized.length)throw new Error('Invalid duplicate canonical name.');
    return write(async tx=>{
      await tx`LOCK TABLE name_variants IN SHARE ROW EXCLUSIVE MODE`;
      const [old]=await tx`SELECT base_key,preferred_name,variants_json FROM name_variants`;
      if(revision(old)!==input.revision)throw new Error('Invalid name list revision; reload before saving.');
      const oldKeys=new Set(old.map(r=>r.base_key));
      const previousKeys=normalized.filter(r=>r.previousBaseKey).map(r=>r.previousBaseKey);
      if(previousKeys.some(k=>!oldKeys.has(k))||new Set(previousKeys).size!==previousKeys.length)throw new Error('Invalid previous name keys.');
      const oldOwners=new Map();
      for(const row of old)for(const name of JSON.parse(row.variants_json)){
        const owners=oldOwners.get(ru(name))||new Set();owners.add(row.base_key);oldOwners.set(ru(name),owners);
      }
      const currentOwners=new Map();
      for(const row of normalized){
        const identity=oldKeys.has(row.previousBaseKey)?row.previousBaseKey:row.baseKey;
        for(const name of row.variants){
          const k=ru(name),owners=currentOwners.get(k)||new Set();
          for(const other of owners)if(!oldOwners.get(k)?.has(other)||!oldOwners.get(k)?.has(identity))throw new Error('Invalid overlapping name variant.');
          owners.add(identity);currentOwners.set(k,owners);
        }
      }
      const [orderRows]=await tx`SELECT record_json FROM report_ownership WHERE owner_key=${'MIGRATION_NAME_VARIANT_ORDER_V1'}`;
      let priorOrder=[];if(orderRows[0]){try{priorOrder=JSON.parse(orderRows[0].record_json).baseKeys||[];}catch{throw new Error('Invalid name order.');}}
      const remap=new Map(normalized.map(r=>[r.previousBaseKey||r.baseKey,r.baseKey]));
      const order=[...priorOrder.filter(k=>remap.has(k)).map(k=>remap.get(k))];
      for(const row of normalized)if(!order.includes(row.baseKey))order.push(row.baseKey);
      await tx`DELETE FROM name_variants`;
      const now=BigInt(Date.now());
      for(const row of normalized)await tx`INSERT INTO name_variants (base_key,preferred_name,variants_json,updated_at)
        VALUES (${row.baseKey},${row.preferredName},${JSON.stringify(row.variants)},${now})`;
      await tx.upsert`INSERT INTO report_ownership (owner_key,record_json,updated_at)
        VALUES (${'MIGRATION_NAME_VARIANT_ORDER_V1'},${JSON.stringify({baseKeys:order})},${now})`;
      return {ok:true};
    });
  }
  return {list,save,remove,replaceAll};
}
