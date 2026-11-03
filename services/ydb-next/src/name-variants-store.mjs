import {Uint64} from '@ydbjs/value/primitive';

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

export function createNameVariantsStore(sql) {
  if(!sql?.begin)throw new Error('YDB query client required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  const list=async()=>read(async tx=>{
    const [rows]=await tx`SELECT base_key,preferred_name,variants_json,updated_at FROM name_variants`;
    return {ok:true,items:rows.map(r=>({
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
      await tx`UPSERT INTO name_variants (base_key,preferred_name,variants_json,updated_at)
        VALUES (${row.baseKey},${row.preferredName},${JSON.stringify(row.variants)},${new Uint64(BigInt(Date.now()))})`;
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
  return {list,save,remove};
}
