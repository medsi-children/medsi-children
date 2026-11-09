import {createHash} from 'node:crypto';

// No child identity is retained: this digest only fences old source reports
// from enrolling a deleted name again before educators publish a fresh report.
export const deletedSourceKey=canonical=>'DELETED_STAFF_NAME_V1_'+createHash('sha256')
  .update(String(canonical||'').trim().normalize('NFC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е')).digest('hex');
export async function deletionCutoff(tx,canonical){
  const [[row]]=await tx`SELECT record_json FROM report_ownership WHERE owner_key=${deletedSourceKey(canonical)}`;
  if(!row)return 0;
  try{const value=Number(JSON.parse(row.record_json).cutoff);return Number.isFinite(value)&&value>=0?value:Infinity}catch{return Infinity}
}
export async function sourcesAfterDeletion(tx,canonical,reports){
  const cutoff=await deletionCutoff(tx,canonical);
  return cutoff?reports.filter(r=>Number(r.submitted_at||0)>cutoff):reports;
}
