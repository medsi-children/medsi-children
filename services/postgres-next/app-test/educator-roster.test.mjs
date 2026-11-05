import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleEducatorRoster,createEducatorRosterStore} from '../app/educator-roster.mjs';

const childId='child_123456789',admissionId='admission_123456789';
test('active children are listed even without parents, and report flags honor admission ownership',()=>{
  const value=assembleEducatorRoster({
    children:[{child_id:childId,registered_first_name:'Миша',surname:'Тестовый'},
      {child_id:'child_333333333',registered_first_name:'Ира',surname:'Тестовая'}],
    admissions:[{admission_id:admissionId,child_id:childId,status:'active'},
      {admission_id:'admission_333333333',child_id:'child_333333333',status:'active'},
      {admission_id:'admission_OLD123456',child_id:childId,status:'closed'}],
    profiles:[{phone10:'9990000001',parent_name:'Мама',relationship:'Мама',child_id:childId,admission_id:admissionId},
      {phone10:'9990000002',parent_name:'Старый профиль',child_id:childId,admission_id:'admission_OLD123456'}],
    currentReports:[{phone10:'9990000001',admission_id:admissionId,kind:'morning',text:'Отчёт'},
      {phone10:'9990000001',admission_id:'admission_OLD123456',kind:'evening',text:'Старый отчёт'}]
  });
  assert.equal(value.children.length,2);
  assert.equal(value.counts.activeParentProfiles,1);
  const misha=value.children.find(c=>c.childId===childId);
  assert.deepEqual({morning:misha.morning,evening:misha.evening},{morning:true,evening:false});
  assert.equal(value.unlinked.length,1);
  assert.equal(value.children.find(c=>c.childId==='child_333333333').parents.length,0);
});

test('roster child editing preserves IDs and the report tables untouched',async()=>{
  const records={child:{registered_first_name:'Миша',surname:'Тестовый'},parent:{child_name:'Миша Тестовый'}};
  let reportTouched=false;
  const sql={begin:async(_cfg,fn)=>fn(async(strings,...args)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(q.includes('FROM admissions WHERE admission_id'))return [[{child_id:childId,status:'active'}]];
    if(q.includes('FROM children WHERE child_id'))return [[records.child]];
    if(q.startsWith('UPDATE children')){records.child={registered_first_name:args[0],surname:args[1]};return [[]]}
    if(q.startsWith('UPDATE parent_profiles')){records.parent.child_name=args[0];return [[]]}
    if(/report|ownership/i.test(q))reportTouched=true;
    throw new Error('Unexpected SQL '+q);
  })};
  const roster=createEducatorRosterStore(sql,{now:()=>123456});
  const result=await roster.update({kind:'child',childId,admissionId,firstName:'Михаил',
    surname:'Тестовый',expectedFirstName:'Миша',expectedSurname:'Тестовый'});
  assert.equal(result.ok,true);
  assert.equal(records.child.registered_first_name,'Михаил');
  assert.equal(records.parent.child_name,'Михаил Тестовый');
  assert.equal(reportTouched,false);
});
