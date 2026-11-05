import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCapturePackage} from '../src/capture-package.mjs';
import {D1_SOURCE_TABLES} from '../src/cloudflare-capture.mjs';
import {verifyManifestEnvelope} from '../app/migration-audit.mjs';
const options={hmacKey:'synthetic-only-full-package-audit-key',freezeConfirmed:true};
function fixture(){return {captureId:'synthetic_capture_001',
  cloudflare:{tables:Object.fromEntries(D1_SOURCE_TABLES.map(name=>[name,[]])),pushEntries:[]},
  roster:{children:[],admissions:[]},reportBaseline:{nameRows:[],raw:[],heads:[],submissions:[],ownership:[]},
  mediaMapping:[],sourceVapidPublicKey:'synthetic-public',targetVapidPublicKey:'synthetic-public'};}
test('all 25 SQL streams and independent S3 stream are assembled and signed',()=>{
  const result=buildCapturePackage(fixture(),options);
  assert.equal(Object.keys(result.streams).length,25);assert.equal(result.envelope.manifests.length,26);
  assert.equal(verifyManifestEnvelope(result.envelope,options.hmacKey),true);
});
test('orphan reports and terminal report receipts remain private jobs, not publications',()=>{
  const input=fixture();input.cloudflare.tables.report_current.push({phone10:'9000000001',kind:'morning',
    text:'Вымышленный отчёт без профиля',profile_generation:'',child_admission_id:'old-admission',updated_at:1000});
  input.cloudflare.tables.report_submission_queue.push({submission_id:'synthetic_report_001',report_type:'morning',
    report_text:'Вымышленный старый отчёт',status:'failed',attempts:3,last_error:'synthetic',result_json:'',created_at:1000,updated_at:2000});
  const result=buildCapturePackage(input,options);
  assert.equal(result.streams.background_jobs.length,2);
  assert.equal(result.streams.parent_current_reports.length,0);assert.equal(result.streams.push_outbox.length,0);
  assert.equal(result.summary.quarantinedReports,1);
});
test('missing sources, inconsistent publication head and absent freeze block package',()=>{
  const missing=fixture();delete missing.cloudflare.tables.chat_profiles;
  assert.throws(()=>buildCapturePackage(missing,options),/incomplete/);
  const changed=fixture();changed.cloudflare.tables.report_publication_state.push({kind:'morning',publication_id:'unknown',revision:1});
  assert.throws(()=>buildCapturePackage(changed,options),/inconsistent/);
  assert.throws(()=>buildCapturePackage(fixture(),{...options,freezeConfirmed:false}),/Frozen/);
});
test('preflight cannot produce a signed import and archives Apps Script state without runnable jobs',()=>{
 const input=fixture();input.appsScriptProperties={REPORT_POST_COMMIT_REQUEST:'synthetic-pending-state'};
 const result=buildCapturePackage(input,{hmacKey:options.hmacKey,preflight:true});
 assert.equal(result.preliminary,true);assert.equal(result.envelope,null);
 assert.equal(result.streams.background_jobs.length,1);assert.equal(result.streams.background_jobs[0].status,'archived');
 input.appsScriptProperties={MEDSI_TUTOR_ACCESS_PASSWORD:'must-not-capture'};
 assert.throws(()=>buildCapturePackage(input,{hmacKey:options.hmacKey,preflight:true}),/incomplete/);
});
