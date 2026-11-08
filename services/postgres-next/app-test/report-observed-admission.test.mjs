import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findUniqueRecentStaffMention as find,
  createAdmissionFromStaffReport as create
} from '../app/report-observed-admission.mjs';

const variants=[{preferred_name:'Анна',variants_json:'["аня","анюта","анечка"]'}];
const children=[{child_id:'child_existing',registered_first_name:'Михаил',surname:'Казьмин'}];
const admissions=[{admission_id:'admission_existing',child_id:'child_existing',status:'active'}];
const report=text=>({kind:'morning',normalized_text:text,raw_text:text,report_date:'2026-11-08'});
const input=(childName,reports,extra={})=>({
  childName,children,admissions,nameVariants:variants,reports,...extra
});

test('one child named Аня in an educator report can be enrolled by Анна/Анюта without surname',()=>{
  const reports=[report('Миша — Читал книгу.\nАня: Участвовала в занятии.')];
  for(const label of ['Анна','Аня','Анюта','Анечка']){
    const candidate=find(input(label,reports));
    assert.equal(candidate?.firstName,'Анна',label);
  }
});
test('parent surname and report initial may support the same single child',()=>{
  const reports=[report('Аня Х. — Занималась рисованием.')];
  assert.equal(find(input('Анна Халитова',reports))?.firstName,'Анна');
  assert.equal(find(input('Анна Пономарёва',reports)),null);
});
test('two duplicate first-name blocks within a report cannot create a guessed hospital identity',()=>{
  assert.equal(find(input('Аня',[
    report('Аня: Занималась рисованием.\nАня: После обеда отдыхала.')
  ])),null);
  assert.equal(find(input('Анна',[
    report('Аня А. — Играла.\nАня Х. — Читала.')
  ])),null);
});
test('contradicting initials across staff reports block automatic enrolment',()=>{
  assert.equal(find(input('Анна',[
    report('Аня А. — Работала с психологом.'),
    report('Анюта Х. — Участвовала в игре.')
  ])),null);
});
test('incidental name inside a paragraph or group therapy never proves a new admission',()=>{
  assert.equal(find(input('Аня',[report('Занятие: Участвовала Аня, а также Миша.')])),null);
  assert.equal(find(input('Аня',[
    {kind:'psychology',normalized_text:'Аня: Была на занятии.'}
  ])),null);
});
test('already active namesake must be resolved using existing child IDs, never duplicated',()=>{
  const child={child_id:'child_anna',registered_first_name:'Анна',surname:'Пономарёва'};
  const admission={admission_id:'admission_anna',child_id:child.child_id,status:'active'};
  assert.equal(find(input('Аня',[report('Аня: Была на занятии.')],{
    children:[...children,child],admissions:[...admissions,admission]
  })),null);
});
test('the prospective child is created only as roster rows, with no medical report writes',async()=>{
  const inserted=[];
  const tx=()=>{throw new Error('Unexpected query')};
  tx.upsert=async(strings,...values)=>{
    inserted.push({sql:strings.join('?').replace(/\s+/g,' ').trim(),values});
    return [[]];
  };
  const result=await create(tx,{...input('Анюта',[
    report('Аня — Была активна.')
  ]),now:1000});
  assert.equal(result.firstName,'Анна');
  assert.equal(result.surname,'');
  assert.match(result.childId,/^child_[a-f0-9]{32}$/);
  assert.match(result.admissionId,/^admission_[a-f0-9]{32}$/);
  assert.equal(inserted.length,2);
  assert.match(inserted[0].sql,/^INSERT INTO children/);
  assert.match(inserted[1].sql,/^INSERT INTO admissions/);
  assert.ok(inserted.every(i=>!/(raw_reports|parent_report_history|parent_current_reports)/.test(i.sql)));
});
