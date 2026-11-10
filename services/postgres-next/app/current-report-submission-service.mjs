import {createCurrentReportPublisher} from './current-report-publications.mjs';
import {findLegacyReportReceipt} from './legacy-report-receipts.mjs';
const ID=/^[A-Za-z0-9_-]{8,128}$/;
export function createCurrentReportSubmissionService(sql){
  const publisher=createCurrentReportPublisher(sql);
  async function submit({kind,rawText,submissionId,authorId,submittedAt=Date.now(),
    correctionOf,clarification}={}){
    const legacy=await sql.begin({isolation:'snapshotReadOnly',idempotent:true},
      tx=>findLegacyReportReceipt(tx,submissionId));
    if(legacy){
      if(legacy.row.report_type!==kind||legacy.row.report_text!==rawText.trim())
        throw new Error('Submission ID already belongs to a different report.');
      if(legacy.row.status==='failed')throw new Error('LEGACY_REPORT_REVIEW_REQUIRED');
      return {...legacy.result,ok:true,status:'duplicate',legacy:true};
    }
    const result=await publisher.publish({kind,rawText,submissionId,authorId,submittedAt,
      correctionOf,clarification});
    return {ok:true,...result,validation:{ok:true,
      ambiguousNames:[],skippedBlocks:Number(result.unresolvedBlocks||0)}};
  }
  async function status(submissionId){
    const value=String(submissionId||'');
    if(!ID.test(value))throw new Error('Invalid submission identifier.');
    return sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>{
      const legacy=await findLegacyReportReceipt(tx,value);
      if(legacy)return legacy.row.status==='completed'
        ?{status:'completed',result:legacy.result}
        :{status:'failed',result:null,message:'Старая отправка не завершилась.'};
      const [[row]]=await tx`SELECT submission_id,kind,publication_id,revision
        FROM report_submissions WHERE submission_id=${value}`;
      return row?{status:'completed',
        result:{ok:true,publicationId:row.publication_id,revision:Number(row.revision||0)}}:
        {status:'not_found'};
    });
  }
  return {submit,status,preview:publisher.preview};
}
