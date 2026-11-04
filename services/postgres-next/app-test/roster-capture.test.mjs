import test from 'node:test';
import assert from 'node:assert/strict';
import {captureSheetsProfileLinks,normalizeRosterCapture} from '../src/roster-capture.mjs';

test('Sheets linkage uses phone, admission ID and generation without interpreting names',()=>{
  const admissions=[{admission_id:'stay-1',status:'active'},{admission_id:'stay-old',status:'discharged'}];
  const row=['+7 (900) 000-00-01','','Совпадающее имя','','','','','stay-1','generation-1'];
  assert.deepEqual(captureSheetsProfileLinks([[],row,[79000000001,...row.slice(1)]],admissions),
    [{phone10:'9000000001',admission_id:'stay-1',profile_generation:'generation-1'}]);
  assert.throws(()=>captureSheetsProfileLinks([row,[...row.slice(0,8),'stale']],admissions),/ambiguous/);
  assert.throws(()=>captureSheetsProfileLinks([[...row.slice(0,7),'stay-old','generation-1']],admissions),/ambiguous/);
});

test('roster keeps separate child IDs when the display names match',()=>{
  const child={registered_first_name:'Тестолина',surname:'Вымышленная',created_at:null};
  const children=[{...child,child_id:'child-a'},{...child,child_id:'child-b'}];
  const first={admission_id:'stay-a',child_id:'child-a',status:'active',admitted_at:null,discharged_at:null};
  assert.equal(normalizeRosterCapture(children,[first,{...first,admission_id:'stay-b',child_id:'child-b'}]).children.length,2);
  assert.throws(()=>normalizeRosterCapture(children,[first,{...first,admission_id:'overlap'}]),/ambiguous/);
});
