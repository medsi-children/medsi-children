import test from 'node:test';
import assert from 'node:assert/strict';
import {captureLegacyReportReceipts} from '../app/legacy-report-receipts.mjs';
import {createReportSubmissionService} from '../app/report-submission-service.mjs';
const row={submission_id:'synthetic_report_001',report_type:'morning',report_text:'Вымышленный отчёт',
  status:'completed',attempts:1,last_error:'',result_json:JSON.stringify({ok:true,publicationId:'synthetic_publication'}),
  created_at:1700000000000,updated_at:1700000001000};
function fixture(source=row){
  const [job]=captureLegacyReportReceipts([source]),calls=[];
  const sql={begin:async(options,fn)=>{
    assert.equal(options.isolation,'snapshotReadOnly');
    return fn(async(strings,...values)=>{
      const query=strings.join('?');calls.push(query);
      assert.match(query,/SELECT payload_json,status,job_type FROM background_jobs/);
      assert.equal(values[0],job.job_id);
      return [[job]];
    });
  }};
  return {service:createReportSubmissionService(sql),calls,job};
}
test('completed legacy receipt is retained losslessly and retry never publishes or pushes',async()=>{
  const {service,calls,job}=fixture();
  assert.deepEqual(JSON.parse(job.payload_json),row);assert.equal(job.status,'archived');
  const result=await service.submit({kind:'morning',rawText:row.report_text,submissionId:row.submission_id});
  assert.equal(result.status,'duplicate');assert.equal(result.publicationId,'synthetic_publication');
  assert.equal((await service.submit({kind:'morning',rawText:'\n '+row.report_text+' \n',submissionId:row.submission_id})).status,'duplicate');
  assert.deepEqual(await service.status(row.submission_id),{status:'completed',result:JSON.parse(row.result_json)});
  assert.equal(calls.length,3);
});
test('failed legacy receipt remains failed and is never automatically replayed',async()=>{
  const {service}=fixture({...row,status:'failed',result_json:'',last_error:'synthetic old failure'});
  const status=await service.status(row.submission_id);assert.equal(status.status,'failed');
  assert.doesNotMatch(status.message,/synthetic old failure/);
  await assert.rejects(()=>service.submit({kind:'morning',rawText:row.report_text,submissionId:row.submission_id}),/REVIEW_REQUIRED/);
});
test('a legacy ID cannot be reused with new content or another report type',async()=>{
  const {service}=fixture();
  for(const change of [{rawText:'Другой синтетический отчёт'},{kind:'evening'}])
    await assert.rejects(()=>service.submit({kind:'morning',rawText:row.report_text,submissionId:row.submission_id,...change}),/different report/);
});
test('unfinished, malformed and duplicate source receipts block capture',()=>{
  for(const change of [{status:'pending'},{status:'processing'},{result_json:'{}'},{attempts:-1},{extra:'unknown'}])
    assert.throws(()=>captureLegacyReportReceipts([{...row,...change}]),/legacy report receipt/);
  assert.throws(()=>captureLegacyReportReceipts([row,row]),/legacy report receipt/);
});
