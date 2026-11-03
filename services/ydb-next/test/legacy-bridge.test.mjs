import test from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyBridge} from '../src/legacy-bridge.mjs';

function setup() {
  const calls=[];
  const sessions={
    verifyTutor:token=>token==='tutor-ok',
    loginTutor:(login,password)=>({ok:login==='staff'&&password==='test',token:'tutor-ok'}),
    renewTutor:()=>({ok:true,d1Session:{token:'educator-token'}}),
    issueEducator:()=>({token:'educator-token',expiresAt:8888888}),
    verifyWorker:async token=>token==='parent-token'
      ?{role:'parent',phone10:'9991112233',exp:99999999}:null
  };
  const services={
    sessions,
    reportReader:{profile:async()=>({ok:true,parentName:'Анна',childName:'Лена'}),
      markRead:async(...args)=>{calls.push(['markRead',...args]);return {ok:true}}},
    chatOperations:{markRead:async(...args)=>{calls.push(['chatMark',...args]);return {ok:true}}},
    reportSubmission:{status:async()=>({status:'completed'})},
    parentRegistration:{status:async()=>({ok:true,status:'PENDING'})},
    parentAccess:{listPending:async()=>({ok:true,requests:[]})}
  };
  return {legacy:createLegacyBridge(services),calls};
}
test('legacy bridge supports old shell without Google or Cloudflare',async()=>{
  const {legacy}=setup();
  assert.equal((await legacy('verifyTutorAccess',['staff','test'])).token,'tutor-ok');
  assert.equal((await legacy('verifyTutorSession',['tutor-ok'])).ok,true);
  assert.equal((await legacy('getD1ChatSession',['parent','89991112233','parent-token'])).session.token,'parent-token');
  assert.equal((await legacy('getParentBootstrap',['89991112233','parent-token'])).childName,'Лена');
});
test('legacy bridge denies cross-parent access and unsupported old writes',async()=>{
  const {legacy,calls}=setup();
  await assert.rejects(()=>legacy('markReportAsRead',['89990001122','morning','v1','parent-token']),/Unauthorized/);
  await assert.rejects(()=>legacy('appendReport',['raw','tutor-ok']),/Unsupported/);
  await assert.rejects(()=>legacy('deleteReportChildByPhone',['89991112233','tutor-ok']),/Unsupported/);
  assert.equal(calls.length,0);
});
