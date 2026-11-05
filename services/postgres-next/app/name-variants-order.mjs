// Apps Script resolves overlapping nicknames in sheet row order. SQL row order
// is unspecified, so preserve that order explicitly across migration/restarts.
export function orderLegacyNameVariants(rows,ownership){
  const record=ownership.find(row=>row.owner_key==='MIGRATION_NAME_VARIANT_ORDER_V1');
  if(!record)return [...rows].sort((a,b)=>a.base_key.localeCompare(b.base_key,'ru'));
  let data;try{data=JSON.parse(record.record_json);}catch{throw new Error('Invalid name variant migration order.');}
  if(!Array.isArray(data.baseKeys)||data.baseKeys.some(k=>typeof k!=='string'||!k)||
     new Set(data.baseKeys).size!==data.baseKeys.length)throw new Error('Invalid name variant migration order.');
  const rank=new Map(data.baseKeys.map((k,i)=>[k,i]));
  return [...rows].sort((a,b)=>(rank.get(a.base_key)??Number.MAX_SAFE_INTEGER)-
    (rank.get(b.base_key)??Number.MAX_SAFE_INTEGER)||a.base_key.localeCompare(b.base_key,'ru'));
}

export function mergeLegacyNameRows(rows){
  const merged=new Map();
  for(const row of rows){
    if(!Array.isArray(row)||typeof row[0]!=='string'||typeof row[1]!=='string')throw new Error('Invalid legacy name row.');
    const base=row[0].normalize('NFC').trim().toLocaleLowerCase('ru').replace(/ё/g,'е');
    const old=merged.get(base);
    // Repeated canon rows union the old group then reassign its entire alias
    // set at the last occurrence, exactly as addNameVariantRow_ does.
    merged.delete(base);
    merged.set(base,[old?.[0]??row[0],old?old[1]+','+row[1]:row[1]]);
  }
  return [...merged.values()];
}
