import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewCurrentReport,remapCurrentBlockOwners,checkedCurrentResolutions}
  from '../app/current-report-clarify.mjs';
import {planCurrentReport} from '../app/current-report-plan.mjs';

const children=[
  {child_id:'child_amina',registered_first_name:'Арина',surname:'Амелина'},
  {child_id:'child_khalit',registered_first_name:'Арина',surname:'Халитова'}
];
const profiles=[
  {phone10:'9000000001',child_id:'child_amina'},
  {phone10:'9000000002',child_id:'child_khalit'},
  {phone10:'9000000003',child_id:'child_khalit'}
];
const args={kind:'evening',profiles,children,nameVariants:[]};
test('ambiguous bare Арина previews exactly the two registered identities',()=>{
  const v=reviewCurrentReport({...args,rawText:'Арина — Играла в настольные игры.'});
  assert.deepEqual(v.conflicts.map(x=>x.candidates.map(c=>c.name)),
    [['Арина Амелина','Арина Халитова']]);
  assert.deepEqual(v.conflicts[0].candidates[1].phones,['9000000002','9000000003']);
  const validated=checkedCurrentResolutions({preview:v,token:v.token,
    resolutions:[{index:0,choice:'child',childId:'child_khalit'}]});
  const planned=planCurrentReport({...args,rawText:'Арина — Играла в настольные игры.',
    manualResolutions:validated});
  assert.deepEqual(planned.recipients.map(x=>x.phone10),
    ['9000000002','9000000003']);
  assert.equal(planned.owners[0].childId,'child_khalit');
  assert.equal(planned.unresolved.length,0);
});
test('ambiguous bare name without clarification never sends to either parent',()=>{
  const p=planCurrentReport({...args,rawText:'Арина — Просто отдыхала.'});
  assert.deepEqual(p.recipients,[]);
  assert.equal(p.owners[0].blocked,true);
});
test('other-new leaves a safely pending source, other-later leaves it quarantined',()=>{
  const rawText='Арина — Играла.';
  const v=reviewCurrentReport({...args,rawText});
  for(const [choice,pending] of [['other-new',true],['other-later',false]]){
    const validated=checkedCurrentResolutions({preview:v,token:v.token,
      resolutions:[{index:0,choice}]});
    const plan=planCurrentReport({...args,rawText,manualResolutions:validated});
    assert.deepEqual(plan.recipients,[]);
    assert.equal(plan.owners[0].pending,pending);
    assert.equal(plan.owners[0].blocked,!pending);
  }
});
test('rejects invented child ID, stale roster token and incomplete choices',()=>{
  const rawText='Арина — Читала.';
  const v=reviewCurrentReport({...args,rawText});
  assert.throws(()=>checkedCurrentResolutions({preview:v,token:v.token,
    resolutions:[{index:0,choice:'child',childId:'child_ghost'}]}),/Invalid child/);
  assert.throws(()=>checkedCurrentResolutions({preview:v,token:'wrong',
    resolutions:[{index:0,choice:'child',childId:'child_khalit'}]}),/roster changed/i);
  assert.throws(()=>checkedCurrentResolutions({preview:v,token:v.token,
    resolutions:[]}),/incomplete/i);
  const stale=reviewCurrentReport({...args,
    profiles:profiles.slice(0,1),rawText});
  assert.notEqual(stale.token,v.token);
});
test('editing source deletes first namesake and keeps second owner by identity',()=>{
  const before='Арина А. — Текст Амелиной.\nАрина Х. — Текст Халитовой.';
  const after='Арина Х. — Новый текст Халитовой.';
  const oldOwners=[{childId:'child_amina'},{childId:'child_khalit'}];
  const remapped=remapCurrentBlockOwners({
    beforeText:before,afterText:after,priorOwners:oldOwners,children
  });
  assert.deepEqual(remapped,[{childId:'child_khalit'}]);
  const plan=planCurrentReport({...args,rawText:after,priorBlockOwners:remapped});
  assert.deepEqual(plan.recipients.map(x=>x.phone10),['9000000002','9000000003']);
  assert.equal(plan.owners[0].childId,'child_khalit');
});
test('editing both namesakes to a bare name requires clarification and cannot steal old owner',()=>{
  const priorOwners=[{childId:'child_amina'},{childId:'child_khalit'}];
  const previous='Арина А. — Разговор.\nАрина Х. — Рисовала.';
  const next='Арина — Рисовала.';
  const remapped=remapCurrentBlockOwners({beforeText:previous,afterText:next,
    priorOwners,children});
  assert.deepEqual(remapped,[undefined]);
  assert.deepEqual(planCurrentReport({...args,rawText:next,
    priorBlockOwners:remapped}).recipients,[]);
  const v=reviewCurrentReport({...args,rawText:next,correctionOf:'pub_old',
    headId:'pub_old'});
  assert.equal(v.conflicts.length,1);
  assert.notEqual(v.token,reviewCurrentReport({...args,rawText:next,
    correctionOf:'pub_old',headId:'pub_new'}).token);
});
test('editing the text of a uniquely verified block keeps the verified child',()=>{
  const before='Арина Х. — Утром играла.';
  const after='Арина Х. — Вечером рисовала.';
  const linked=remapCurrentBlockOwners({beforeText:before,afterText:after,
    priorOwners:[{childId:'child_khalit'}],children});
  assert.deepEqual(linked,[{childId:'child_khalit'}]);
});
test('one block cannot be assigned to two guardians of different children',()=>{
  const plan=planCurrentReport({...args,
    rawText:'Арина — Первый блок.\nАрина — Второй блок.',
    manualResolutions:[
      {index:0,choice:'child',childId:'child_khalit'},
      {index:1,choice:'child',childId:'child_khalit'}
    ]
  });
  assert.deepEqual(plan.recipients,[]);
  assert.equal(plan.owners.every(x=>x.blocked),true);
});
