import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findUniqueActiveAdmissionForParent as find,
  reconcileUnlinkedRegisteredParents as reconcile
} from '../app/parent-admission-matching.mjs';

const children=[
  {child_id:'child_anna1',registered_first_name:'Анна',surname:'Пономарёва'},
  {child_id:'child_anna2',registered_first_name:'Анюта',surname:'Халитова'},
  {child_id:'child_anna3',registered_first_name:'Анна',surname:'Христофорова'}
];
const admissions=[
  {admission_id:'adm_anna1',child_id:'child_anna1',status:'active'},
  {admission_id:'adm_anna2',child_id:'child_anna2',status:'closed'},
  {admission_id:'adm_anna3',child_id:'child_anna3',status:'closed'}
];
const nameVariants=[{preferred_name:'анна',variants_json:'["аня","анюта","анечка"]'}];
const opts=(childName,changes={})=>({
  childName,children,admissions,nameVariants,...changes
});
const activeTwo=admissions.map(a=>({...a,status:a.admission_id==='adm_anna2'?'active':a.status}));
const activeThree=admissions.map(a=>({...a,status:'active'}));

test('sole active Аня links any registered variant WITHOUT surname',()=>{
  for(const form of ['Аня','Анна','Анюта','Анечка','АНЯ']){
    const result=find(opts(form));
    assert.equal(result?.childId,'child_anna1',form);
    assert.equal(result?.admissionId,'adm_anna1',form);
  }
});
test('parent first name and matching full surname or initial identify child',()=>{
  assert.equal(find(opts('Анюта Пономарёва'))?.admissionId,'adm_anna1');
  assert.equal(find(opts('Аня П.'))?.admissionId,'adm_anna1');
  assert.equal(find(opts('Аня Х.',{admissions:activeTwo}))?.admissionId,'adm_anna2');
  assert.equal(find(opts('Анна Халитова',{admissions:activeTwo}))?.admissionId,'adm_anna2');
});
test('two namesakes without suffix or with shared initial remain unlinked',()=>{
  assert.equal(find(opts('Аня',{admissions:activeTwo})),null);
  assert.equal(find(opts('Аня Х.',{admissions:activeThree})),null);
  assert.equal(find(opts('Аня Ха',{admissions:activeThree}))?.admissionId,'adm_anna2');
});
test('contradictory name, closed admission and overlapping alias never grant link',()=>{
  assert.equal(find(opts('Аня Сидорова')),null);
  assert.equal(find(opts('Софья')),null);
  assert.equal(find(opts('Аня',{admissions:admissions.map(a=>({...a,status:'closed'}))})),null);
  assert.equal(find(opts('Аня',{nameVariants:[
    ...nameVariants,
    {preferred_name:'мария',variants_json:'["аня"]'}
  ]})),null);
});
test('no hospital record is invented from an unsupported raw report reference',()=>{
  assert.equal(find(opts('Аня',{children:[],admissions:[]})),null);
});

function fakeReconciliation({rawOnly=false}={}){
  const profiles=[{
    phone10:'9000000055',child_name:'Анюта',
    child_id:'',admission_id:'',profile_generation:'reg_test_012345678901'
  }];
  const auth=[{phone10:profiles[0].phone10}];
  const attempts=[{attempt_id:profiles[0].profile_generation,phone10:profiles[0].phone10,status:'COMPLETED'}];
  let reportQueries=0,updates=0;
  const hospitalChildren=[...children],hospitalAdmissions=rawOnly
    ?admissions.map(row=>({...row,status:'closed'})):[...admissions];
  const reported=rawOnly?[{kind:'morning',normalized_text:'Аня — Участвовала в занятии.',raw_text:'Аня: Участвовала в занятии.',report_date:'2026-11-08'}]:[];
  const sql={begin:async(_opts,fn)=>{
    const tx=async(strings,...params)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(/^(INSERT|UPDATE|DELETE)/.test(q)&&/report_(?:history|current)|raw_reports/.test(q))reportQueries++;
      if(q.startsWith('SELECT phone10,child_name,child_id,admission_id,profile_generation FROM parent_profiles'))return [profiles];
      if(q.startsWith('SELECT phone10 FROM parent_auth_profiles'))return [auth];
      if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [[...hospitalChildren]];
      if(q.startsWith('SELECT admission_id,child_id,status FROM admissions'))return [[...hospitalAdmissions]];
      if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [nameVariants];
      if(q.startsWith('SELECT kind,raw_text,normalized_text,report_date FROM raw_reports'))return [reported];
      if(q.startsWith('UPDATE parent_profiles SET child_id=')){
        const [childId,admissionId,,phone]=params;
        const p=profiles.find(p=>p.phone10===phone&&!p.child_id&&!p.admission_id);
        if(!p)return [[]];
        p.child_id=childId;p.admission_id=admissionId;updates++;
        return [[{phone10:phone}]];
      }
      if(q.startsWith('UPDATE parent_registration_attempts SET child_id=')){
        const [childId,admissionId,,attemptId,phone]=params;
        const a=attempts.find(a=>a.attempt_id===attemptId&&a.phone10===phone);
        if(a){a.child_id=childId;a.admission_id=admissionId}
        return [[]];
      }
      throw new Error('Unexpected SQL: '+q);
    };
    tx.upsert=async(strings,...params)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.startsWith('INSERT INTO children')){
        hospitalChildren.push({child_id:params[0],registered_first_name:params[1],surname:params[2]});return [[]];
      }
      if(q.startsWith('INSERT INTO admissions')){
        hospitalAdmissions.push({admission_id:params[0],child_id:params[1],status:params[2]});return [[]];
      }
      throw new Error('Unexpected insert: '+q);
    };
    return fn(tx);
  }};
  return {sql,profiles,attempts,hospitalChildren,hospitalAdmissions,
    get reportQueries(){return reportQueries},get updates(){return updates}};
}
test('existing bot registration is safely linked retroactively and only once',async()=>{
  const fake=fakeReconciliation();
  const first=await reconcile(fake.sql,{now:()=>1700});
  assert.deepEqual(first,{ok:true,linked:1,review:0});
  assert.equal(fake.profiles[0].admission_id,'adm_anna1');
  assert.equal(fake.attempts[0].admission_id,'adm_anna1');
  const second=await reconcile(fake.sql);
  assert.deepEqual(second,{ok:true,linked:0,review:0});
  assert.equal(fake.updates,1);
  assert.equal(fake.reportQueries,0);
});

test('earlier registered parent is automatically connected after an educator first mentions a new child',async()=>{
  const fake=fakeReconciliation({rawOnly:true});
  const first=await reconcile(fake.sql,{now:()=>Date.parse('2026-11-08T12:00:00Z')});
  assert.deepEqual(first,{ok:true,linked:1,review:0});
  const parent=fake.profiles[0];
  assert.equal(fake.hospitalAdmissions.filter(x=>x.status==='active').length,1);
  assert.equal(parent.admission_id,fake.hospitalAdmissions.find(x=>x.status==='active').admission_id);
  const generated=fake.hospitalChildren.find(c=>c.child_id===parent.child_id);
  assert.equal(generated.registered_first_name,'Анна');
  assert.equal(fake.attempts[0].admission_id,parent.admission_id);
  const second=await reconcile(fake.sql,{now:()=>Date.parse('2026-11-08T12:00:00Z')});
  assert.equal(second.linked,0);
  assert.equal(fake.hospitalAdmissions.filter(x=>x.status==='active').length,1);
  assert.equal(fake.reportQueries,0);
});


test('sole active child without a known surname accepts a parent supplied surname; known contradiction and namesakes block',()=>{
  const roster=[{child_id:'child_new',registered_first_name:'Степан',surname:''}];
  const stays=[{admission_id:'admission_new',child_id:'child_new',status:'active'}];
  assert.deepEqual(find({childName:'Степан Тестовый',children:roster,admissions:stays}),{childId:'child_new',admissionId:'admission_new'});
  assert.equal(find({childName:'Степан Тестовый',children:[{...roster[0],surname:'Другой'}],admissions:stays}),null);
  assert.equal(find({childName:'Степан Тестовый',children:[...roster,{child_id:'child_other',registered_first_name:'Степан',surname:''}],admissions:[...stays,{admission_id:'admission_other',child_id:'child_other',status:'active'}]}),null);
});
