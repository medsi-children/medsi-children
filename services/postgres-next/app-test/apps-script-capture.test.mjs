import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../ops/postgres-apps-script-capture.js',import.meta.url),'utf8');
function fixture({drift=false,missing=false}={}){
  let reads=0,released=0,writes=0;
  const properties={MEDSI_SPREADSHEET_ID:'synthetic-sheet',D1_SESSION_SECRET:'secret-not-to-export',RAW_REPORT_OWNER_test:'synthetic-owner'};
  const sheets=['REPORTS','MORNING','EVENING','PSYCHOLOGY','NAME_VARIANTS'];
  const context=vm.createContext({LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>released++})},
    PropertiesService:{getScriptProperties:()=>({getProperties:()=>({...properties}),setProperty:()=>writes++})},
    SpreadsheetApp:{openById:()=>({getSheets:()=>sheets.map(name=>({getName:()=>name})),getSheetByName:name=>{
      if(!sheets.includes(name)||(missing&&name==='MORNING'))return null;
      return {getLastRow:()=>1,getLastColumn:()=>1,getRange:()=>({getValues:()=>{reads++;return [[drift?reads:'synthetic']];}})};
    }})}});
  vm.runInContext(source,context);
  return {run:input=>context.medsiCaptureFrozenMigration(input),released:()=>released,writes:()=>writes};
}
const request={freezeConfirmed:true,captureId:'synthetic_capture_001'};
test('Apps Script capture is read-only and excludes authentication secrets',()=>{
  const f=fixture(),data=f.run(request);
  assert.equal(Object.keys(data.sheets).length,5);
  assert.equal(data.properties.D1_SESSION_SECRET,undefined);
  assert.ok(data.omittedPropertyNames.includes('D1_SESSION_SECRET'));
  assert.equal(f.writes(),0);assert.equal(f.released(),1);
});
test('Apps Script capture rejects missing sheets and source drift, always releases lock',()=>{
  for(const options of [{missing:true},{drift:true}]){
    const f=fixture(options);assert.throws(()=>f.run(request),/capture failed/);assert.equal(f.released(),1);
  }
});
test('Apps Script capture refuses reads before freeze approval',()=>{
  assert.throws(()=>fixture().run({...request,freezeConfirmed:false}),/Explicit frozen/);
});
