import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRosterCapture} from '../src/roster-capture.mjs';

test('roster keeps separate child IDs when the display names match',()=>{
  const child={registered_first_name:'Тестолина',surname:'Вымышленная',created_at:null};
  const children=[{...child,child_id:'child-a'},{...child,child_id:'child-b'}];
  const first={admission_id:'stay-a',child_id:'child-a',status:'active',admitted_at:null,discharged_at:null};
  assert.equal(normalizeRosterCapture(children,[first,{...first,admission_id:'stay-b',child_id:'child-b'}]).children.length,2);
  assert.throws(()=>normalizeRosterCapture(children,[first,{...first,admission_id:'overlap'}]),/ambiguous/);
});
