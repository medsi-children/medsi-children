import {currentReportVersion} from './current-report-plan.mjs';
import {normalizeCurrentReportPunctuation} from './current-report-punctuation.mjs';
const PHONE=/^\d{10}$/;
const ID=/^[A-Za-z0-9_-]{8,128}$/;
export function createCurrentEducatorReportEditsStore(sql){
  if(!sql?.begin)throw Error('PostgreSQL required.');
  async function update(input={}){
    const phone10=String(input.phone10||''),childId=String(input.childId||'');
    const kind=String(input.kind||''),rawText=input.text;
    if(!PHONE.test(phone10)||!ID.test(childId)||
      !['morning','evening'].includes(kind)||typeof rawText!=='string'||rawText.length>240000)
      throw new Error('Invalid distributed report edit. Edit shared therapy at its common source.');
    const text=normalizeCurrentReportPunctuation(rawText);
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[profile]]=await tx`SELECT child_id FROM parent_profiles WHERE phone10=${phone10}`;
      const [[child]]=await tx`SELECT child_id FROM children WHERE child_id=${childId}`;
      if(!profile||!child||profile.child_id!==childId)
        throw new Error('Report recipient is no longer registered.');
      const [[current]]=await tx`SELECT publication_id,revision,text,child_id FROM parent_current_reports
        WHERE phone10=${phone10} AND kind=${kind} FOR UPDATE`;
      if(!current||current.child_id!==childId)throw new Error('Distributed report not found.');
      if(input.expectedText!==undefined&&input.expectedText!==current.text&&
        input.expectedText!==normalizeCurrentReportPunctuation(current.text))
        throw new Error('Report changed; reload before editing.');
      const version=currentReportVersion({kind,childId,text,publicationId:current.publication_id});
      const at=BigInt(Date.now());
      await tx`UPDATE parent_current_reports SET text=${text},version=${version},
        read_version=${''},updated_at=${at}
        WHERE phone10=${phone10} AND kind=${kind} AND child_id=${childId}`;
      const [[raw]]=await tx`SELECT report_date FROM raw_reports
        WHERE publication_id=${current.publication_id}`;
      if(raw?.report_date){
        await tx.upsert`INSERT INTO parent_report_history
          (phone10,kind,report_date,child_id,publication_id,revision,text,captured_at)
          VALUES (${phone10},${kind},${raw.report_date},${childId},
            ${current.publication_id},${current.revision},${text},${at})`;
      }
      return {ok:true,version};
    });
  }
  return {update};
}
