import {createHash} from 'node:crypto';

const PHONE=/^\d{10}$/;
const ENTRY=/^[A-Za-z0-9_-]{12,180}$/;
const sha=value=>createHash('sha256').update(value,'utf8').digest('hex');
const clean=value=>String(value??'').trim().replace(/\s+/gu,' ').slice(0,160);
function normalizePhone(value){
  const digits=String(value??'').replace(/\D/g,'');
  if(digits.length===10&&PHONE.test(digits))return digits;
  if(digits.length===11&&['7','8'].includes(digits[0]))return digits.slice(1);
  throw new Error('Invalid archive phone.');
}
export function validateParentDirectoryImport(rows){
  if(!Array.isArray(rows)||rows.length<1||rows.length>500)
    throw new Error('Import must contain 1 to 500 records.');
  return rows.map((item,i)=>{
    const phone10=normalizePhone(item?.phone??item?.phone10);
    const parentName=clean(item?.parentName);
    const childName=clean(item?.childName);
    const childSurname=clean(item?.childSurname);
    if(!parentName||!childName)throw new Error('Archive row is missing required names.');
    const sourceRow=Number(item?.sourceRow??i+2);
    if(!Number.isSafeInteger(sourceRow)||sourceRow<2||sourceRow>100000)
      throw new Error('Invalid archive source row.');
    const entryId='legacy_'+sha([sourceRow,phone10,parentName,childName,childSurname].join('\u0000')).slice(0,48);
    return {entryId,phone10,parentName,childName,childSurname};
  });
}

export function createParentDirectory({sql,now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL archive storage required.');
  const read=fn=>sql.begin({isolation:'snapshotReadOnly',idempotent:true},fn);
  const write=fn=>sql.begin({isolation:'serializableReadWrite',idempotent:true},fn);
  async function list(){
    const [rows]=await read(tx=>tx`SELECT entry_id,phone10,parent_name,child_name,child_surname
      FROM parent_directory_archive ORDER BY created_at DESC,entry_id DESC LIMIT 5000`);
    // The directory only exposes contact information. Technical storage
    // timestamps and record origins are intentionally not part of its API.
    return {ok:true,rows:rows.map(row=>({
      entryId:row.entry_id,phone:'7'+row.phone10,
      parentName:row.parent_name,childName:row.child_name,
      childSurname:row.child_surname
    }))};
  }
  async function importRows(rows){
    const source=validateParentDirectoryImport(rows);
    const inserted=await write(async tx=>{
      let count=0;
      for(const row of source){
        const [added]=await tx`INSERT INTO parent_directory_archive
          (entry_id,phone10,parent_name,child_name,child_surname,source,registered_at,created_at)
          VALUES (${row.entryId},${row.phone10},${row.parentName},
            ${row.childName},${row.childSurname},${'legacy_import'},${null},${BigInt(now())})
          ON CONFLICT (phone10) DO NOTHING RETURNING entry_id`;
        count+=added.length;
      }
      return count;
    });
    return {ok:true,total:source.length,inserted,skipped:source.length-inserted};
  }
  async function remove(entryId){
    const id=String(entryId||'');
    if(!ENTRY.test(id))throw new Error('Invalid archive identifier.');
    const [deleted]=await write(tx=>tx`DELETE FROM parent_directory_archive
      WHERE entry_id=${id} RETURNING entry_id`);
    return {ok:true,deleted:deleted.length>0};
  }
  return {list,importRows,remove};
}
