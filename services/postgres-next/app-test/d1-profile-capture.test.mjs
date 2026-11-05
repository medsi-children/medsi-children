import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeD1ParentProfiles,captureD1ParentProfileManifest,captureD1ProfileLinks} from '../src/d1-profile-capture.mjs';

const profile={phone10:'9000000001',parent_name:'Вымышленный родитель',child_name:'Тестолина',
  relationship:'Родитель',child_genitive:'Тестолины',profile_generation:'generation-1',child_admission_id:'stay-1'};
const link={phone10:profile.phone10,profile_generation:profile.profile_generation,admission_id:'stay-1'};
const admission={admission_id:'stay-1',child_id:'child-1',status:'active'};

test('links by verified generation and admission, keeping multiple parents of one child',()=>{
  const second={...profile,phone10:'9000000002',profile_generation:'generation-2'};
  const links=[link,{...link,phone10:second.phone10,profile_generation:second.profile_generation}];
  const rows=normalizeD1ParentProfiles([profile,second],links,[admission]);
  assert.deepEqual(rows.map(row=>[row.child_id,row.admission_id,row.created_at]),
    [['child-1','stay-1',null],['child-1','stay-1',null]]);
  assert.equal(captureD1ParentProfileManifest([profile,second],links,[admission],
    'synthetic-only-manifest-key-0123456789').count,2);
});

test('D1 unlinked parent stays unlinked despite stale Sheets-style admission link',()=>{
  const unlinked={...profile,child_admission_id:''};
  assert.deepEqual(captureD1ProfileLinks([unlinked]),[]);
  const rows=normalizeD1ParentProfiles([unlinked],[],[]);
  assert.equal(rows[0].child_id,'');assert.equal(rows[0].admission_id,'');
  assert.throws(()=>normalizeD1ParentProfiles([unlinked],[link],[admission]),/ambiguous/);
  assert.deepEqual(captureD1ProfileLinks([profile]),[link]);
});

test('rejects missing, stale, conflicting and inactive links without guessing by name',()=>{
  for(const [profiles,links,admissions] of [
    [[profile],[],[admission]],
    [[profile],[{...link,profile_generation:'old'}],[admission]],
    [[{...profile,child_admission_id:'old'}],[link],[admission]],
    [[profile],[link],[{...admission,status:'discharged'}]],
    [[profile],[link,link],[admission]]
  ]){
    assert.throws(()=>normalizeD1ParentProfiles(profiles,links,admissions),/ambiguous/);
  }
});
