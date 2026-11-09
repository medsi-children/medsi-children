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
    registeredPhones:[{phone10:'9990000001'},{phone10:'9990000002'}],
    currentReports:[{phone10:'9990000001',admission_id:admissionId,kind:'morning',text:'Отчёт'},
      {phone10:'9990000001',admission_id:'admission_OLD123456',kind:'evening',text:'Старый отчёт'}]
  });
  assert.equal(value.children.length,2);
  assert.equal(value.counts.activeParentProfiles,1);
  const misha=value.children.find(c=>c.childId===childId);
  assert.deepEqual({morning:misha.morning,evening:misha.evening},{morning:true,evening:false});
  assert.equal(value.unlinked.length,0,'profiles with prior admissions stay out of the genuinely unlinked list');
  assert.equal(value.review.length,1,'a closed-admission profile is not offered as an unlinked parent');
  assert.equal(value.review[0].reason,'stale-admission');
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


test('new parent can chat before any report or admission match and is returned as unlinked',()=>{
  const result=assembleEducatorRoster({
    children:[
      {child_id:'child_new_123456',registered_first_name:'Арина',surname:'Алексеева'}
    ],
    admissions:[
      {admission_id:'admission_new_123456',child_id:'child_new_123456',status:'active'}
    ],
    profiles:[
      {phone10:'9000000021',parent_name:'Новый родитель',relationship:'Мама',
        child_name:'Арина Алексеева',child_id:'child_new_123456',
        admission_id:'admission_new_123456'},
      {phone10:'9000000022',parent_name:'Пишет в чате',relationship:'Папа',
        child_name:'Другая Арина',child_id:'',admission_id:''}
    ],
    registeredPhones:[{phone10:'9000000021'},{phone10:'9000000022'}],
    currentReports:[]
  });
  assert.equal(result.ok,true);
  assert.equal(result.children.length,1);
  assert.equal(result.children[0].parents.length,1);
  assert.equal(result.children[0].morning,false);
  assert.equal(result.children[0].evening,false);
  assert.equal(result.unlinked.length,1);
  assert.equal(result.unlinked[0].parentName,'Пишет в чате');
  assert.equal(result.unlinked[0].childName,'Другая Арина');
  assert.equal(result.unlinked[0].phone,'89000000022');
  assert.equal(result.unlinked[0].linked,false);
  assert.equal(result.counts.unlinkedProfiles,1);
});

test('unlinked parent can choose between namesakes named in the recent raw report',()=>{
  const otherId='child_987654321';
  const result=assembleEducatorRoster({
    children:[{child_id:childId,registered_first_name:'Миша',surname:'Тестовый'},
      {child_id:otherId,registered_first_name:'Миша',surname:'Другой'}],
    admissions:[{admission_id:admissionId,child_id:childId,status:'active'},
      {admission_id:'admission_987654321',child_id:otherId,status:'active'}],
    profiles:[{phone10:'9990000001',parent_name:'Мама',child_name:'Миша',child_id:'',admission_id:''}],
    registeredPhones:[{phone10:'9990000001'}],
    rawReports:[{kind:'morning',report_date:'2026-11-09',raw_text:'Миша — Свежая заметка'}]
  });
  assert.equal(result.unlinked.length,1);
  assert.deepEqual(result.unlinked[0].assignable.map(row=>row.childId),[childId,otherId]);
});

test('manual assignment is limited to a truly unlinked profile and a child named in a recent raw report',async()=>{
  const profile={child_id:'',admission_id:'',profile_generation:'reg_123456789012',child_name:'Миша'};
  const child={child_id:childId,registered_first_name:'Миша',surname:'Тестовый'};
  const other={child_id:'child_987654321',registered_first_name:'Миша',surname:'Другой'};
  const calls=[];
  const sql={begin:async(_cfg,fn)=>fn(async(strings,...args)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();calls.push(q);
    if(q.includes('FROM parent_profiles WHERE phone10=')&&q.includes('FOR UPDATE'))return [[profile]];
    if(q.includes('FROM admissions WHERE admission_id='))return [[{child_id:childId,status:'active'}]];
    if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [[child,other]];
    if(q.startsWith('SELECT admission_id,child_id,status FROM admissions'))return [[{admission_id:admissionId,child_id:childId,status:'active'},
      {admission_id:'admission_987654321',child_id:other.child_id,status:'active'}]];
    if(q.startsWith('SELECT kind,raw_text,normalized_text,report_date FROM raw_reports'))return [[{kind:'morning',raw_text:'Миша — Свежая заметка',report_date:'2026-11-09'}]];
    if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [[]];
    if(q.startsWith('UPDATE parent_profiles SET child_id=')){profile.child_id=args[0];profile.admission_id=args[1];return [[{phone10:args[2]}]];}
    if(q.startsWith('UPDATE parent_registration_attempts SET child_id='))return [[]];
    throw new Error('Unexpected SQL '+q);
  })};
  const roster=createEducatorRosterStore(sql,{now:()=>Date.parse('2026-11-09T12:00:00Z')});
  const result=await roster.update({kind:'assign',phone10:'9990000001',childId,admissionId});
  assert.equal(result.ok,true);assert.equal(profile.child_id,childId);assert.equal(profile.admission_id,admissionId);
  assert.ok(calls.some(q=>q.includes('FROM raw_reports')));
  assert.ok(calls.some(q=>q.startsWith('UPDATE parent_registration_attempts')));
  assert.ok(!calls.some(q=>/parent_current_reports|parent_report_history|raw_reports.*(?:UPDATE|INSERT)/i.test(q)));
});

test('manual assignment refuses stale or ambiguous mappings without changing report history',async()=>{
  const profile={child_id:childId,admission_id:'admission_OLD123456',child_name:'Миша Тестовый'};
  const sql={begin:async(_cfg,fn)=>fn(async(strings)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(q.includes('FROM parent_profiles WHERE phone10=')&&q.includes('FOR UPDATE'))return [[profile]];
    if(q.includes('FROM admissions WHERE admission_id='))return [[{child_id:childId,status:'active'}]];
    throw new Error('Unexpected SQL '+q);
  })};
  const roster=createEducatorRosterStore(sql);
  await assert.rejects(()=>roster.update({kind:'assign',phone10:'9990000001',childId,admissionId}),/Parent roster changed/);
  assert.equal(profile.admission_id,'admission_OLD123456');
});
