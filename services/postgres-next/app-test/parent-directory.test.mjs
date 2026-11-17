import test from 'node:test';
import assert from 'node:assert/strict';
import {createParentDirectory,validateParentDirectoryImport} from '../app/parent-directory.mjs';

function fixture(){
  const archive=new Map(),currentProfiles=new Set(['9000000001']);
  const sql={async begin(_options,callback){
    const tx=async(strings,...values)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.startsWith('SELECT entry_id,phone10,parent_name')){
        const rows=[...archive.values()].sort((a,b)=>Number(b.created_at-a.created_at));
        return [rows];
      }
      if(q.startsWith('INSERT INTO parent_directory_archive')){
        if([...archive.values()].some(row=>row.phone10===values[1]))return [[]];
        const row={entry_id:values[0],phone10:values[1],parent_name:values[2],
          child_name:values[3],child_surname:values[4],source:values[5],
          registered_at:values[6],created_at:values[7]};
        archive.set(row.entry_id,row);
        return [[{entry_id:row.entry_id}]];
      }
      if(q.startsWith('DELETE FROM parent_directory_archive')){
        const had=archive.delete(values[0]);
        return [had?[{entry_id:values[0]}]:[]];
      }
      throw Error('Unexpected SQL: '+q);
    };
    return callback(tx);
  }};
  return {archive,currentProfiles,service:createParentDirectory({sql,now:()=>1720000000000})};
}
const importData=[{phone:'89000000001',parentName:'Тестовый взрослый',
  childName:'Тестовый ребёнок',childSurname:'Синтетический',sourceRow:2},
  {phone:'89000000002',parentName:'Другой взрослый',
  childName:'Второй ребёнок',childSurname:'',sourceRow:3}];
test('legacy import is independent, idempotent and shows contact fields only',async()=>{
  const {service,archive,currentProfiles}=fixture();
  const first=await service.importRows(importData);
  assert.equal(first.inserted,2);assert.equal(first.skipped,0);
  const second=await service.importRows(importData);
  assert.equal(second.inserted,0);assert.equal(second.skipped,2);
  assert.equal(archive.size,2);
  let result=await service.list();
  assert.equal(result.rows.length,2);
  assert.equal(result.rows.find(r=>r.phone==='79000000002').childSurname,'');
  assert.equal(result.rows.every(r=>!Object.hasOwn(r,'registeredAt')&&!Object.hasOwn(r,'source')),true);
  // Simulate discharge: the archive is not bound to the active parent profile.
  currentProfiles.delete('9000000001');
  assert.equal((await service.list()).rows.length,2);
  const entryId=result.rows[0].entryId;
  assert.equal((await service.remove(entryId)).deleted,true);
  assert.equal((await service.list()).rows.length,1);
  assert.equal(currentProfiles.size,0);
});
test('one normalized phone cannot create duplicates from differing rows or reused registration data',async()=>{
  const {service,archive}=fixture();
  const first=await service.importRows([importData[0]]);
  assert.equal(first.inserted,1);
  const second=await service.importRows([
    {...importData[0],phone:'+7 (900) 000-00-01',
      childName:'Другой ребёнок',sourceRow:105}
  ]);
  assert.equal(second.inserted,0);
  assert.equal(second.skipped,1);
  assert.equal(archive.size,1);
  assert.equal((await service.list()).rows[0].childName,'Тестовый ребёнок');
});
test('archive import rejects bad phones and missing required names',()=>{
  assert.throws(()=>validateParentDirectoryImport([]),/1 to 500/);
  assert.throws(()=>validateParentDirectoryImport([{...importData[0],phone:'123'}]),/phone/);
  assert.throws(()=>validateParentDirectoryImport([{...importData[0],parentName:''}]),/names/);
  assert.throws(()=>validateParentDirectoryImport(Array(501).fill(importData[0])),/500/);
});
