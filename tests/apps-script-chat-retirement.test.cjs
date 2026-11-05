const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
function apps(){
  const x={Logger:{log(){}},UrlFetchApp:{fetch(){throw Error('Unexpected network access')}},SpreadsheetApp:{openById(){throw Error('Unexpected sheet access')}}};
  vm.createContext(x);
  fs.readdirSync(path.join(root,'apps-script/medsi-bot')).filter(f=>f.endsWith('.js')).forEach(f=>vm.runInContext(read('apps-script/medsi-bot/'+f),x));
  return x;
}
const manifest=JSON.parse(read('tests/fixtures/apps-script-legacy-chat/manifest.json'));
test('archived historical implementations match their recorded baseline digests',()=>{
  const old={};vm.createContext(old);vm.runInContext(read('tests/fixtures/apps-script-legacy-chat/retired-chat.js'),old);
  for(const item of manifest.removedFunctions){
    assert.equal(crypto.createHash('sha256').update(old[item.name].toString()).digest('hex'),item.sha256,item.name);
  }
});
test('cached legacy chat methods fail explicitly without touching any storage',()=>{
  const x=apps();
  for(const method of manifest.retiredPublicMethods){
    const result=x.handleApiRequest_({method,args:['9990000001']});
    assert.equal(result.ok,true,method);
    assert.equal(result.result.ok,false,method);
    assert.equal(result.result.code,'LEGACY_CHAT_RETIRED',method);
  }
  for(const method of ['constructor','toString','__proto__','smartRegisterFromInboxCore','smartRegisterFromInboxCore_','distributeChildReports','cleanupInactiveChatMessages','testDriveAccess']){
    assert.equal(x.handleApiRequest_({method,args:[]}).ok,false,method);
  }
});
test('installed legacy cleanup triggers are harmless and only retired timers are removed',()=>{
  const x=apps();
  assert.equal(x.cleanupInactiveChatMessages().code,'LEGACY_CHAT_RETIRED');
  assert.equal(x.cleanupExpiredChatImages().code,'LEGACY_CHAT_RETIRED');
  const names=['cleanupInactiveChatMessages','cleanupExpiredChatImages','syncD1ProfilesFromReports','retryPendingReportsD1ProfileSync','distributeChildReports','onReportsD1Change'];
  const removed=[];const triggers=names.map(name=>({getHandlerFunction:()=>name}));
  x.ScriptApp={getProjectTriggers:()=>triggers,deleteTrigger:t=>removed.push(t.getHandlerFunction())};
  x.retireLegacyChatCleanupTriggers_();
  assert.deepEqual(removed,names.slice(0,2));
});
test('direct parent D1 fallback checks the signed session before any storage or network access',()=>{
  const x=apps();let checked=0;
  x.requireParentAccess_=(phone,session)=>{checked++;assert.equal(phone,'9990000001');assert.equal(session,'invalid');throw Error('Denied')};
  assert.throws(()=>x.getD1ThreadForParent('9990000001','',30,'invalid'),/Denied/);
  assert.throws(()=>x.sendD1MessageForParent('9990000001',{text:'synthetic'},'invalid'),/Denied/);
  assert.equal(checked,2);
});
test('signed parent compatibility send forwards its session to the D1 sender',()=>{
  const x=apps();let forwarded;
  x.requireParentAccess_=()=>{};x.isPhoneActiveInReports_=()=>true;
  x.getProfileByPhone_=()=>({phone:'9990000001'});
  x.sendD1MessageForParent=(phone,message,session)=>{forwarded={phone,message,session};return {ok:true,message:{key:'synthetic'}}};
  x.legacyD1MessageResult_=value=>value;
  assert.equal(x.sendParentChatMessage('9990000001','synthetic','','signed-synthetic').ok,true);
  assert.equal(forwarded.session,'signed-synthetic');assert.equal(forwarded.message.text,'synthetic');
});
test('discharge still closes D1, cleans raw reports and contacts without legacy sheets',()=>{
  const x=apps(),events=[];
  const rows=[['9990000001','Анна','Александра Б','Синтетическая'],['9990000002','Мария','Александр Б','Синтетический']];
  x.withChatWriteLock_=fn=>fn();
  x.getDataSheet_=()=>({getLastRow:()=>3,getRange:()=>({getValues:()=>rows}),deleteRow:r=>events.push('row:'+r)});
  x.rawReportChildTargetFromReportRow_=r=>({phone:r[0]});
  x.rawReportTargetsNoLongerActive_=targets=>targets;
  x.prepareRawReportCleanupForChildren_=(targets,all)=>{assert.equal(targets.length,1);assert.equal(all.length,2);return {synthetic:true}};
  x.deleteD1ProfileWithS3Purge_=phone=>{events.push('d1:'+phone);return {deleted:true}};
  x.applyRawReportCleanup_=()=>{events.push('raw');return {removedBlocks:1}};
  x.removeReportInactivityState_=phone=>events.push('inactivity:'+phone);
  x.removeMedsiParentContactBestEffort_=phone=>events.push('contact:'+phone);
  const result=x.deleteReportChildByPhoneCore_('9990000001',null);
  assert.equal(result.ok,true);assert.equal(result.cleanupComplete,true);
  assert.equal(result.deletedReportRows,1);assert.equal(result.deletedD1Profiles,1);assert.equal(result.deletedRawReportBlocks,1);
  assert.deepEqual(events,['d1:9990000001','raw','row:2','inactivity:9990000001','contact:9990000001']);
});
test('phone directory and Cloudflare-first profile lookup work without historical chat sheets',()=>{
  const x=apps();x.requireTutorSession_=()=>{};
  x.getDataSheet_=()=>({getLastRow:()=>2,getRange:()=>({getValues:()=>[['9990000001','Анна','Никита И','Синтетический','','','Мама']]})});
  assert.equal(x.listAvailableParentsForChat('synthetic').ok,true);
  x.getDataSheet_=()=>({getLastRow:()=>1});x.isPhoneActiveInReports_=()=>true;
  x.d1AdminRequest_=()=>({profile:{phone:'9990000001',parentName:'Анна',childName:'Никита Синтетический'}});
  assert.equal(x.getProfileByPhone_('9990000001').childName,'Никита Синтетический');
  x.d1AdminRequest_=()=>{throw Error('offline')};assert.equal(x.getProfileByPhone_('9990000001'),null);
});
test('current page script graph has no retired adapter and all literal API methods remain supported',()=>{
  const x=apps(),methods=x.getApiMethodMap_(),seen=new Set(),pending=['index.html','tutors.html','psychology.html'];
  while(pending.length){
    const file=pending.shift();if(seen.has(file))continue;seen.add(file);
    const source=read(file);
    assert.doesNotMatch(source,/chat-adapter\.html/);
    for(const match of source.matchAll(/["'](\/(?:parents|tutors|psychology|chat-overlay)\/[^"'\s?]+\.js|\/notify-client\.js)(?:\?[^"'\s]*)?["']/g))pending.push(match[1].slice(1));
    for(const match of source.matchAll(/\b(?:callApi|callAppsScript|callServer)\(\s*['"]([^'"]+)['"]/g)){
      assert.equal(typeof methods[match[1]],'function',file+':'+match[1]);
      assert.notEqual(methods[match[1]],x.retiredLegacyChatApi_,file+':'+match[1]);
    }
  }
  assert.ok(seen.size>=50);
  assert.doesNotMatch(read('apps-script/medsi-bot/.claspignore'),/!chat-adapter\.html/);
});
