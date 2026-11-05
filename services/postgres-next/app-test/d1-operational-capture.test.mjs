import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareD1OperationalCapture} from '../src/d1-operational-capture.mjs';
const secret='synthetic-operational-capture-audit-key';
const empty=()=>Object.fromEntries(['parent_auth_challenges','parent_deletion_queue','parent_registration_attempts',
  'parent_access_requests','parent_registration_outbox','report_submission_queue','report_inactivity_state',
  'report_push_dedup','report_state_import_runs','report_publication_state'].map(name=>[name,[]]));
test('terminal workflow IDs and source-only fields survive without executable jobs',()=>{
  const source=empty();source.parent_deletion_queue.push({operation_id:'synthetic-deletion',phone10:'9000000001',
    status:'completed',attempts:2,child_name:'Вымышленный ребёнок',result_json:'{"ok":true}',created_at:100,updated_at:200});
  source.parent_registration_attempts.push({attempt_id:'synthetic-registration',phone10:'9000000002',status:'COMPLETED',created_at:100});
  source.report_inactivity_state.push({phone10:'9000000002',first_seen_at:100,last_prompt_days:3});
  const result=prepareD1OperationalCapture(source,secret);
  assert.equal(result.parent_deletion_queue[0].operation_id,'synthetic-deletion');
  assert.equal(result.parent_deletion_queue[0].child_id,null);
  assert.equal(result.parent_registration_attempts[0].attempt_id,'synthetic-registration');
  assert.equal(result.background_jobs.length,2);
  assert.equal(JSON.parse(result.background_jobs[0].payload_json).record.child_name,'Вымышленный ребёнок');
  assert.ok(result.background_jobs.every(row=>row.status==='archived'&&row.next_attempt_at===null));
  assert.deepEqual(prepareD1OperationalCapture(source,secret),result);
});
test('missing stream, unfinished mirror, deletion or registration blocks capture',()=>{
  const missing=empty();delete missing.parent_access_requests;
  assert.throws(()=>prepareD1OperationalCapture(missing,secret),/incomplete/);
  for(const [table,row] of [['parent_registration_outbox',{}],
    ['parent_deletion_queue',{operation_id:'synthetic-deletion',status:'failed'}],
    ['parent_registration_attempts',{attempt_id:'synthetic-registration',status:'PENDING'}]]){
    const source=empty();source[table].push(row);
    assert.throws(()=>prepareD1OperationalCapture(source,secret),/unresolved/);
  }
});

test('access requests preserve the terminal status casing used by the current Worker',()=>{
  for(const status of ['CONSUMED','DENIED','EXPIRED']){
    const source=empty();source.parent_access_requests.push({request_id:'synthetic-request',status});
    assert.equal(prepareD1OperationalCapture(source,secret).parent_access_requests[0].status,status);
  }
  const source=empty();source.parent_access_requests.push({request_id:'synthetic-request',status:'PENDING'});
  assert.throws(()=>prepareD1OperationalCapture(source,secret),/unresolved/);
});
