import test from 'node:test';
import assert from 'node:assert/strict';
import {installSchema} from '../src/schema-cli.mjs';
import {connectPostgresNext} from '../src/connection.mjs';
import {POSTGRES_STREAMS} from '../src/postgres-manifests.mjs';
import {generateManifest,signManifestEnvelope} from '../app/migration-audit.mjs';
import {importFullCapture} from '../src/full-import.mjs';
import {captureLegacyReportReceipts} from '../app/legacy-report-receipts.mjs';
import {createReportSubmissionService} from '../app/report-submission-service.mjs';
import {buildCapturePackage} from '../src/capture-package.mjs';
import {D1_SOURCE_TABLES} from '../src/cloudflare-capture.mjs';

test('full capture: signed atomic import, exact retry and rejection of tampering',{
  skip:process.env.CI==='true'&&process.env.PG_TEST_INSECURE_LOCAL==='1'?false:'Disposable CI PostgreSQL only.'
},async()=>{
  await installSchema({...process.env,PG_SCHEMA_CONFIRM:'CREATE_SCHEMA_IN_EMPTY_DATABASE'});
  const conn=await connectPostgresNext(process.env);
  try{
    const key='synthetic-audit-key-'.repeat(4);
    const streams=Object.fromEntries(POSTGRES_STREAMS.map(name=>[name,[]]));
    streams.children.push({child_id:'fictional_child',registered_first_name:'Test',surname:'Synthetic',created_at:'1000'});
    const receipt={submission_id:'synthetic_report_001',report_type:'morning',report_text:'Вымышленный отчёт',
      status:'completed',attempts:1,last_error:'',result_json:JSON.stringify({ok:true,publicationId:'legacy_synthetic'}),
      created_at:1700000000000,updated_at:1700000001000};
    streams.background_jobs=captureLegacyReportReceipts([receipt,
      {...receipt,submission_id:'synthetic_report_002',status:'failed',result_json:''}]);
    const s3=generateManifest('s3_objects',[],key);
    const tables=Object.fromEntries(D1_SOURCE_TABLES.map(name=>[name,[]]));
    tables.report_submission_queue=[receipt,{...receipt,submission_id:'synthetic_report_002',status:'failed',result_json:''}];
    const assembled=buildCapturePackage({captureId:'synthetic_capture_001',cloudflare:{tables,pushEntries:[]},
      roster:{children:streams.children,admissions:[]},reportBaseline:{nameRows:[],raw:[],heads:[],submissions:[],ownership:[]},
      mediaMapping:[],sourceVapidPublicKey:'synthetic-public',targetVapidPublicKey:'synthetic-public'},
      {hmacKey:key,freezeConfirmed:true});
    assert.deepEqual(assembled.streams,streams);
    const source=assembled.envelope;
    const options={hmacKey:key,explicitImport:true,freezeConfirmed:true};
    await assert.rejects(()=>importFullCapture(conn.sql,streams,source,s3,{...options,freezeConfirmed:false}),/frozen/);
    await assert.rejects(()=>importFullCapture(conn.sql,{...streams,children:[]},source,s3,options),/mismatch/);
    await assert.rejects(()=>importFullCapture(conn.sql,streams,{...source,signature:'0'.repeat(64)},s3,options),/mismatch/);
    const [before]=await conn.sql`SELECT * FROM children`;
    assert.equal(before.length,0);
    // Simulate a transport failure after an INSERT; the real adapter must roll
    // back every user stream, not leave a partially imported destination.
    const faulty={begin:(opts,fn)=>conn.sql.begin(opts,tx=>{
      const proxy=async(strings,...values)=>{
        const result=await tx(strings,...values);
        if(strings[0].startsWith('INSERT'))throw new Error('Synthetic interruption');
        return result;
      };
      proxy.identifier=tx.identifier;
      return fn(proxy);
    })};
    await assert.rejects(()=>importFullCapture(faulty,streams,source,s3,options),/Synthetic interruption/);
    const [rolledBack]=await conn.sql`SELECT * FROM children`;
    assert.equal(rolledBack.length,0);
    assert.deepEqual(await importFullCapture(conn.sql,streams,source,s3,options),{alreadyImported:false,streams:25});
    assert.deepEqual(await importFullCapture(conn.sql,streams,source,s3,options),{alreadyImported:true,streams:25});
    const reports=createReportSubmissionService(conn.sql);
    assert.equal((await reports.submit({kind:'morning',rawText:receipt.report_text,
      submissionId:receipt.submission_id})).status,'duplicate');
    assert.equal((await reports.status('synthetic_report_002')).status,'failed');
    await assert.rejects(()=>reports.submit({kind:'morning',rawText:receipt.report_text,
      submissionId:'synthetic_report_002'}),/REVIEW_REQUIRED/);
    const [raw]=await conn.sql`SELECT * FROM raw_reports`;
    const [push]=await conn.sql`SELECT * FROM push_outbox`;
    assert.equal(raw.length,0);assert.equal(push.length,0);
    const newer={...streams,children:[{...streams.children[0],surname:'Updated'},
      {child_id:'fictional_added',registered_first_name:'Second',surname:'Synthetic',created_at:'2000'}]};
    const nextEnvelope=signManifestEnvelope('synthetic_capture_002',[...POSTGRES_STREAMS.map(name=>generateManifest(name,newer[name],key)),s3],key);
    await assert.rejects(()=>importFullCapture(conn.sql,newer,nextEnvelope,s3,options),/populated/);
    await assert.rejects(()=>importFullCapture(faulty,newer,nextEnvelope,s3,{...options,previousEnvelope:source}),/Synthetic interruption/);
    const [afterFailedDelta]=await conn.sql`SELECT * FROM children`;
    assert.equal(afterFailedDelta.length,1);assert.equal(afterFailedDelta[0].surname,'Synthetic');
    assert.deepEqual(await importFullCapture(conn.sql,newer,nextEnvelope,s3,{...options,previousEnvelope:source}),{alreadyImported:false,streams:25});
    assert.deepEqual(await importFullCapture(conn.sql,newer,nextEnvelope,s3,{...options,previousEnvelope:source}),{alreadyImported:true,streams:25});
    await conn.sql`UPDATE children SET surname=${'Changed'} WHERE child_id=${'fictional_child'}`;
    await assert.rejects(()=>importFullCapture(conn.sql,streams,source,s3,options),/populated/);
  }finally{await conn.driver.close();}
});
