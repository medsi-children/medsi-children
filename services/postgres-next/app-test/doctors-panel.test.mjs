import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import test from 'node:test';
import AdmZip from 'adm-zip';
import express from 'express';
import pg from 'pg';
import {createPostgresSql} from '../src/connection.mjs';
import {createDoctorsRouter} from '../app/doctors-router.mjs';
import {createDoctorsPlans,selectCurrentPlans} from '../app/doctors-plans.mjs';
import {createGreenwoodSource,decodeGreenwood} from '../app/doctors-greenwood.mjs';
import {createDoctorsRoster} from '../app/doctors-roster.mjs';
import {readPlanDates,updatePlanDischarge} from '../app/doctors-xlsx.mjs';

const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SHEET='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function book(dates,patient='Тестов Пациент 15 лет'){
  const zip=new AdmZip();
  const add=(path,text)=>zip.addFile(path,Buffer.from(text));
  add('xl/workbook.xml',`<workbook xmlns="${SHEET}" xmlns:r="${REL}"><sheets><sheet name="ДЕТСКИЙ СТАЦИОНАР" r:id="rId1"/></sheets></workbook>`);
  add('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  add('xl/sharedStrings.xml',`<sst xmlns="${SHEET}"><si><t>${dates}</t></si></sst>`);
  add('xl/worksheets/sheet1.xml',`<worksheet xmlns="${SHEET}"><sheetData><row r="4"><c r="B4" t="inlineStr"><is><t>Дата, время:</t></is></c><c r="C4" s="1" t="s"><v>0</v></c><c r="G4" t="s"><v>0</v></c></row><row r="5"><c r="B5" t="inlineStr"><is><t>Ф.И.О. пациента, возраст:</t></is></c><c r="C5" t="inlineStr"><is><t>${patient}</t></is></c></row><row r="6"><c r="F6"><f>C6*D6</f><v>123</v></c></row></sheetData><mergeCells><mergeCell ref="C4:F4"/></mergeCells></worksheet>`);
  return zip.toBuffer();
}
test('writes only the selected XLSX cell and preserves time, shared references and formulas',()=>{
  const source=book('29.02.2024 12:30 – 01.03.2024 14:00');
  assert.equal(readPlanDates(source).discharge,'2024-03-01');
  const updated=updatePlanDischarge(source,'2024-03-06');
  assert.equal(readPlanDates(updated).discharge,'2024-03-06');
  const after=new AdmZip(updated);
  assert.deepEqual(after.readFile('xl/sharedStrings.xml'),new AdmZip(source).readFile('xl/sharedStrings.xml'));
  const sheet=after.readAsText('xl/worksheets/sheet1.xml');
  assert.match(sheet,/29\.02\.2024 12:30 – 06\.03\.2024 14:00/);
  assert.match(sheet,/<c r="G4" t="s"><v>0<\/v><\/c>/);
  assert.match(sheet,/<f>C6\*D6<\/f>/);
  assert.match(sheet,/<mergeCell ref="C4:F4"/);
  assert.throws(()=>updatePlanDischarge(source,'2024-02-28'));
  assert.throws(()=>readPlanDates(book('29.02.2025')));
  assert.equal(readPlanDates(updatePlanDischarge(book('29.02.2024 — '),'2024-03-03')).discharge,'2024-03-03');
});
test('selects one discharge date by stay, final plan, version and a stable date tie-break',()=>{
  const today='2024-02-08';
  const prior={admission:'2024-01-01',discharge:'2024-01-22',final:true,modified:'3',nameDate:''};
  const current={admission:'2024-02-01',discharge:'2024-02-22',final:false,modified:'1',nameDate:''};
  assert.equal(selectCurrentPlans([prior,current],today).discharge,current.discharge);
  assert.equal(selectCurrentPlans([current,{...current,final:true,discharge:'2024-02-20'}],today).discharge,'2024-02-20');
  assert.equal(selectCurrentPlans([current,{...current,modified:'2',discharge:'2024-02-20'}],today).discharge,'2024-02-20');
  const later={...current,discharge:'2024-02-27'};
  assert.equal(selectCurrentPlans([current,later],today).discharge,later.discharge);
  assert.equal(selectCurrentPlans([later,{...current,discharge:null},current],today).discharge,later.discharge);
});
test('Greenwood accepts only the projected columns and detects ambiguous rows',()=>{
  const row={c:[{v:'Тестов Пациент'},{v:'Date(2024,1,29)',f:'29.02.2024'}]};
  const encode=rows=>'/*O_o*/\ngoogle.visualization.Query.setResponse('+JSON.stringify({
    status:'ok',table:{cols:[{id:'C'},{id:'G'}],rows}
  })+');';
  assert.equal(decodeGreenwood(encode([row]))[0].episode,'2024-02-29');
  assert.throws(()=>decodeGreenwood(encode([row,row])));
  assert.throws(()=>decodeGreenwood('<html>Sign in</html>'));
});
test('a removed Greenwood row disappears from the roster after a refresh',async()=>{
  const row={c:[{v:'Тестов Пациент'},{v:'Date(2024,1,29)',f:'29.02.2024'}]};
  const env={DOCTORS_GREENWOOD_SHEET_ID:'synthetic',NEXT_SESSION_SECRET:'synthetic-roster-secret'};
  let now=0,rows=[row],requests=0;
  const greenwood=createGreenwoodSource(env,async()=>{
    requests++;
    const response={status:'ok',table:{cols:[{id:'C'},{id:'G'}],rows}};
    return new Response('google.visualization.Query.setResponse('+JSON.stringify(response)+');');
  },()=>now);
  const roster=createDoctorsRoster(()=>assert.fail('Authoritative roster must not fall back to PostgreSQL'),env,{greenwood});
  assert.equal((await roster.list()).length,1);
  rows=[];
  assert.equal((await roster.list()).length,1);
  assert.deepEqual(await roster.list({refresh:true}),[]);
  assert.equal(requests,2);
  rows=[row];
  now+=30000;
  assert.equal((await roster.list()).length,1);
  rows=[];
  now+=30000;
  assert.deepEqual(await roster.list(),[]);
});
test('Greenwood keeps undated rows and uses an explicitly configured discharge fallback',async()=>{
  const env={DOCTORS_GREENWOOD_SHEET_ID:'synthetic',DOCTORS_GREENWOOD_DISCHARGE_COLUMN:'H',NEXT_SESSION_SECRET:'synthetic-roster-secret'};
  const rows=[
    {c:[{v:'Тестов Пациент'},{v:'Date(2024,1,29)',f:'29.02.2024'},{v:'Date(2024,2,10)',f:'10.03.2024'}]},
    {c:[{v:'Другой Пациент'},null,null]}
  ];
  const greenwood=createGreenwoodSource(env,async url=>{
    assert.equal(new URL(url).searchParams.get('tq'),'select C,G,H where C is not null');
    return new Response('google.visualization.Query.setResponse('+JSON.stringify({
      status:'ok',table:{cols:[{id:'C'},{id:'G'},{id:'H'}],rows}
    })+');');
  });
  const sql=()=>assert.fail('No automatic contact lookup');
  const roster=createDoctorsRoster(sql,env,{greenwood,plans:{dates:async()=>({admission:null,discharge:null,editable:true})}});
  const [dated,undated]=await roster.list();
  assert.equal(dated.discharge,'2024-03-10');
  assert.equal(undated.discharge,null);
  assert.equal(undated.editable,false);
  const override=createDoctorsRoster(sql,env,{greenwood,plans:{dates:async()=>({discharge:'2024-03-12',editable:true})}});
  assert.equal((await override.list())[0].discharge,'2024-03-12');
  assert.throws(()=>decodeGreenwood('', 'C'));
});
test('Greenwood contacts require explicit episode-specific verified links',async()=>{
  const env={NEXT_SESSION_SECRET:'synthetic-roster-secret'};
  const row={key:'тестов пациент|2024-02-29',childName:'Тестов Пациент',episode:'2024-02-29'};
  let rows=[row];
  const greenwood={configured:true,read:async()=>rows};
  const sql=async()=>[[{phone10:'9000000001',parent_name:'Тестовый родитель',
    child_id:'child_synthetic',registered_first_name:'Пациент',surname:'Тестов'}]];
  const roster=createDoctorsRoster(sql,env,{greenwood});
  const [patient]=await roster.list();
  const [bot]=await roster.listBot();
  assert.deepEqual(patient.parents,[]);
  const linked=createDoctorsRoster(sql,{...env,DOCTORS_VERIFIED_CONTACT_LINKS:JSON.stringify([[patient.id,bot.id]])},{greenwood});
  assert.equal((await linked.list())[0].parents.length,1);
  rows=[{...row,key:'тестов пациент|2024-03-29',episode:'2024-03-29'}];
  assert.deepEqual((await linked.list())[0].parents,[]);
  rows=[row];
  const duplicate=createDoctorsRoster(sql,{...env,DOCTORS_VERIFIED_CONTACT_LINKS:JSON.stringify([[patient.id,bot.id],[patient.id,bot.id]])},{greenwood});
  assert.deepEqual((await duplicate.list())[0].parents,[]);
});
test('doctor routes require their own cookie and only publish psychotherapy',async t=>{
  const calls=[];
  const service={doctorsRoster:{list:async()=>[]},reports:{submit:async opts=>calls.push(opts)}};
  const app=express();
  app.use('/doctors/api',createDoctorsRouter(service,{NEXT_TUTOR_LOGIN:'test',NEXT_TUTOR_PASSWORD:'test-pass',
    NEXT_SESSION_SECRET:'synthetic-key-that-is-more-than-32-characters',DOCTORS_LOCAL_HTTP:'1'}));
  const server=app.listen(0,'127.0.0.1');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port+'/doctors/api';
  assert.equal((await fetch(base+'/patients',{headers:{'X-Medsi-Chat-Session':'educator'}})).status,401);
  const login=await fetch(base+'/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({login:'test',password:'test-pass'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const patientResponse=await fetch(base+'/patients',{headers:{cookie}});
  assert.equal(patientResponse.status,200);
  assert.equal(patientResponse.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/parent-directory/import',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,404);
  const publication=await fetch(base+'/psychology',{method:'POST',headers:{cookie,'content-type':'application/json'},
    body:JSON.stringify({text:'Синтетический отчёт',submissionId:'report_fixture',reportType:'morning'})});
  assert.equal(publication.status,200);
  assert.equal(calls[0].kind,'psychology');
});

test('persists a change and syncs all three current plans across a PostgreSQL-backed restart',{
  skip:!process.env.MEDSI_DOCTORS_TEST_PG_PORT
},async t=>{
  const pool=new pg.Pool({host:'127.0.0.1',port:Number(process.env.MEDSI_DOCTORS_TEST_PG_PORT),
    database:process.env.PGDATABASE||'postgres',max:2});
  t.after(()=>pool.end());
  const sql=createPostgresSql(pool);
  const patientId='synthetic-'+randomUUID();
  const testRoot='disk:/synthetic-doctor-plan-copies';
  const folder=testRoot+'/Тестов Пациент 15';
  const records=new Map([
    [folder+'/План итог дополнительный.xlsx',book('01.02.2024-16.02.2024')],
    [folder+'/План итог.xlsx',book('01.02.2024-16.02.2024')],
    [folder+'/План ещё.xlsx',book('01.02.2024')],
    [folder+'/Старый итоговый план.xlsx',book('01.01.2023-16.01.2023')],
    [folder+'/Пересекающийся старый план.xlsx',book('25.01.2024-16.02.2024')]
  ]);
  const writes=[],backups=new Map();
  let interrupt=true;
  const stat=path=>({type:'file',name:path.split('/').at(-1),path,
    sha256:hash(records.get(path)),modified:'2024-02-05T00:00:00Z'});
  const disk={
    async list(path){return path===testRoot?[{type:'dir',name:'Тестов Пациент 15',path:folder}]:[...records.keys()].map(stat);},
    async stat(path){return stat(path);},
    async download(path){return records.get(path);},
    async upload(path,bytes){
      if(interrupt && writes.length===1){interrupt=false;throw new Error('Synthetic upload outage');}
      writes.push(path);records.set(path,bytes);
    }
  };
  const storage={configured:true,async hasObject(key){return backups.has(key);},
    async putBuffer(key,bytes,mime){assert.equal(mime,MIME);backups.set(key,bytes);},
    async sha256Object(key){return hash(backups.get(key));}};
  const create=()=>createDoctorsPlans({sql,storage,disk,env:{
    DOCTORS_DISK_ROOT:testRoot,DOCTORS_DISK_WRITE_TEST_ROOT:testRoot,DOCTORS_DISK_TEST_WRITE:'1'
  },listPatients:async()=>[{id:patientId,childName:'Пациент Тестов',episode:'2024-02-01'}]});
  const first=create();
  await first.start();
  first.stop();
  const prior=await first.dates(patientId);
  assert.equal(prior.discharge,'2024-02-16');
  assert.equal((await first.enqueue(patientId,'2024-02-19',prior.revision)).ok,true);
  assert.equal((await first.dates(patientId)).discharge,'2024-02-19');
  const second=create();
  await second.start();
  second.stop();
  assert.equal(writes.length,1);
  const restarted=create();
  await restarted.start();
  restarted.stop();
  assert.equal(backups.size,3);
  assert.equal(writes.length,3);
  for(const path of writes)assert.equal(readPlanDates(records.get(path)).discharge,'2024-02-19');
  assert.equal(readPlanDates(records.get(folder+'/Старый итоговый план.xlsx')).discharge,'2023-01-16');
  assert.equal(readPlanDates(records.get(folder+'/Пересекающийся старый план.xlsx')).discharge,'2024-02-16');
  const synced=await restarted.dates(patientId);
  assert.equal(synced.discharge,'2024-02-19');
  assert.equal((await restarted.enqueue(patientId,'2024-02-25',synced.revision)).ok,true);
  const independentPath=folder+'/План итог.xlsx';
  records.set(independentPath,book('01.02.2024-21.02.2024'));
  const independent=create();
  await independent.start();
  independent.stop();
  const resolved=await independent.dates(patientId);
  assert.equal(resolved.discharge,'2024-02-25');
  assert.equal(resolved.syncConflict,true);
  assert.equal(readPlanDates(records.get(independentPath)).discharge,'2024-02-21');
  assert.equal(writes.length,3);
  const retry=create();
  await retry.start();retry.stop();
  assert.equal(writes.length,3,'a conflicting operation cannot resume automatically');
  assert.equal((await retry.dates(patientId)).syncConflict,true);
  // Explicitly saving after review creates a new operation against the latest snapshot.
  assert.equal((await retry.enqueue(patientId,'2024-02-25',(await retry.dates(patientId)).revision)).status,409);
  assert.equal((await retry.enqueue(patientId,'2024-02-25',(await retry.dates(patientId)).revision,true)).ok,true);
  const confirmed=create();
  await confirmed.start();confirmed.stop();
  assert.equal((await confirmed.dates(patientId)).syncConflict,false);
  assert.equal(readPlanDates(records.get(independentPath)).discharge,'2024-02-25');
  assert.ok([...backups.values()].some(bytes=>readPlanDates(bytes).discharge==='2024-02-21'));
  assert.equal(writes.length,6);
});

test('one broken folder cannot starve other patients, and removed registry rows stop writes',{
  skip:!process.env.MEDSI_DOCTORS_TEST_PG_PORT
},async t=>{
  const pool=new pg.Pool({host:'127.0.0.1',port:Number(process.env.MEDSI_DOCTORS_TEST_PG_PORT),
    database:process.env.PGDATABASE||'postgres',max:2});
  t.after(()=>pool.end());
  const sql=createPostgresSql(pool);
  const root='disk:/synthetic-isolation';
  const bad={id:'synthetic-'+randomUUID(),childName:'Тестов Пациент',episode:'2024-02-01'};
  const good={id:'synthetic-'+randomUUID(),childName:'Другой Пациент',episode:'2024-02-01'};
  const badPath=root+'/Тестов Пациент';
  const goodPath=root+'/Другой Пациент';
  const path=goodPath+'/План.xlsx';
  let bytes=book('01.02.2024-16.02.2024','Другой Пациент'),writes=0,reads=0,removeDuringWrite=false;
  const stat=()=>({type:'file',name:'План.xlsx',path,sha256:hash(bytes),modified:'2024-02-05T00:00:00Z'});
  const disk={
    async list(requested){
      if(requested===root)return [{type:'dir',name:'Тестов Пациент',path:badPath},{type:'dir',name:'Другой Пациент',path:goodPath}];
      if(requested===badPath)throw new Error('Synthetic broken directory');
      assert.equal(requested,goodPath);
      return [stat()];
    },
    async stat(){return stat();},
    async download(){return bytes;},
    async upload(_path,next){writes++;bytes=next;}
  };
  const backups=new Map();
  const storage={configured:true,async hasObject(key){return backups.has(key);},
    async putBuffer(key,content){backups.set(key,content);},
    async sha256Object(key){return hash(backups.get(key));}};
  const create=()=>createDoctorsPlans({sql,storage,disk,env:{
    DOCTORS_DISK_ROOT:root,DOCTORS_DISK_WRITE_TEST_ROOT:root,DOCTORS_DISK_TEST_WRITE:'1'
  },listPatients:async()=>removeDuringWrite && ++reads>=2?[bad]:[bad,good]});
  const first=create();await first.start();first.stop();
  const before=await first.dates(good.id);
  assert.equal(before.discharge,'2024-02-16','a preceding broken folder must not stop a good scan');
  assert.equal((await first.enqueue(good.id,'2024-02-19',before.revision)).ok,true);
  removeDuringWrite=true;
  const second=create();await second.start();second.stop();
  assert.equal(writes,0,'patient removed during scan must never be written');
  assert.equal(backups.size,0);
  assert.equal(readPlanDates(bytes).discharge,'2024-02-16');
  assert.equal((await second.dates(good.id)).discharge,'2024-02-19','pending intent is retained without overwriting source');
});
