import test from 'node:test';
import assert from 'node:assert/strict';
import {inferParentRelationship,effectiveParentRelationship} from '../app/current-parent-relationship.mjs';
import {assembleCurrentEducatorRoster,createCurrentEducatorRosterStore} from '../app/current-educator-roster.mjs';
import {assembleCurrentEducatorDashboard} from '../app/current-educator-dashboard.mjs';
import {createCurrentParentRegistrationService} from '../app/current-parent-registration.mjs';

test('legacy dictionary correctly recognizes ordinary Russian first names',()=>{
  for(const [name,expected] of [
    ['Анна','Мама'],['Павел','Папа'],['Мария Ивановна','Мама'],
    ['Алексей','Папа'],['Евгения','Мама'],['Евгений','Папа'],
    ['Паша','Папа'],['Катя','Мама'],['Алёна','Мама'],
    ['Саша','Родитель'],['Женя','Родитель'],['Валя','Родитель'],
    ['Неизвестное','Родитель'],['','Родитель'],['1234','Родитель'],
  ])assert.equal(inferParentRelationship(name),expected,name);
});

test('old generic roles infer automatically; explicit manual roles remain intact',()=>{
  assert.equal(effectiveParentRelationship('Родитель','Павел'),'Папа');
  assert.equal(effectiveParentRelationship(' родитель ','Анна'),'Мама');
  assert.equal(effectiveParentRelationship(null,'Анна'),'Мама');
  for(const role of ['Бабушка','Дедушка','Тётя','Дядя','Сестра','Брат','Опекун']){
    assert.equal(effectiveParentRelationship(role,'Анна'),role);
    assert.equal(effectiveParentRelationship(role,'Павел'),role);
  }
});

test('the staff roster and dashboard show inferred and manually selected relatives',()=>{
  const children=[{child_id:'child_synthetic_001',registered_first_name:'Лиза',surname:'Тестовая'}];
  const profiles=[
    {phone10:'9000000001',parent_name:'Анна',relationship:'Родитель',child_id:'child_synthetic_001'},
    {phone10:'9000000002',parent_name:'Павел',relationship:'Родитель',child_id:'child_synthetic_001'},
    {phone10:'9000000003',parent_name:'Наталья',relationship:'Бабушка',child_id:'child_synthetic_001'},
    {phone10:'9000000004',parent_name:'Александр',relationship:'Родитель',child_id:''}
  ];
  const roster=assembleCurrentEducatorRoster({children,profiles,
    authenticated:profiles.map(x=>({phone10:x.phone10}))});
  assert.deepEqual(roster.children[0].parents.map(p=>p.relationship),['Мама','Бабушка','Папа']);
  assert.equal(roster.unlinked[0].relationship,'Папа');
  const dashboard=assembleCurrentEducatorDashboard({children,profiles});
  assert.deepEqual(dashboard.children[0].parents.map(p=>p.relationship),['Мама','Папа','Бабушка']);
});

test('an educator can edit an old placeholder profile using its displayed inferred role',async()=>{
  const record={parent_name:'Павел',relationship:'Родитель',child_id:'child_synthetic_001'};
  const writes=[];
  const sql={begin:async(_options,callback)=>{
    const tx=async(strings,...values)=>{
      const query=strings.join('?').replace(/\s+/g,' ').trim();
      if(query.startsWith('SELECT parent_name,relationship,child_id FROM parent_profiles'))return [[record]];
      if(query.startsWith('UPDATE parent_profiles SET parent_name=')){
        writes.push(values);
        record.parent_name=values[0];record.relationship=values[1];
        return [[]];
      }
      throw Error('Unexpected SQL '+query);
    };
    return callback(tx);
  }};
  const roster=createCurrentEducatorRosterStore(sql,{now:()=>1234});
  await roster.update({kind:'parent',phone10:'9000000001',childId:record.child_id,
    parentName:'Павел',relationship:'Дедушка',
    expectedParentName:'Павел',expectedRelationship:'Папа'});
  assert.equal(record.relationship,'Дедушка');
  assert.equal(writes.length,1);
  await assert.rejects(()=>roster.update({kind:'parent',phone10:'9000000001',childId:record.child_id,
    parentName:'Павел',relationship:'Папа',
    expectedParentName:'Павел',expectedRelationship:'Папа'}),/Roster changed/);
});

async function registerRole(parentName){
  const writes=[];
  const sql={begin:async(_config,cb)=>{
    const tx=async(strings)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(q.startsWith('SELECT status FROM parent_deletion_queue'))return [[]];
      if(q.startsWith('SELECT attempt_id,phone10,parent_name,child_name,status'))return [[null]];
      if(q.startsWith('SELECT phone10,profile_generation FROM parent_profiles'))return [[null]];
      throw Error('Unexpected SQL '+q);
    };
    tx.upsert=async(strings,...values)=>{
      const q=strings.join('?').replace(/\s+/g,' ').trim();
      if(!q.startsWith('INSERT INTO parent_profiles')&&
         !q.startsWith('INSERT INTO parent_auth_profiles')&&
         !q.startsWith('INSERT INTO parent_registration_attempts'))throw Error('Unexpected write '+q);
      writes.push({q,values});return [[]];
    };
    return cb(tx);
  }};
  const registration=createCurrentParentRegistrationService({
    sql,sessions:{issueParent:async()=>({token:'synthetic-session'})},
    now:()=>Date.parse('2026-11-15T12:00:00Z')
  });
  const result=await registration.register({
    phone:'9000000001',attemptId:'reg_synthetic_1234567890',
    parentName,childName:'Лиза Тестовая'
  });
  assert.equal(result.ok,true);
  const insert=writes.find(x=>x.q.startsWith('INSERT INTO parent_profiles'));
  return insert.values[3];
}
test('new registrations persist mama or papa immediately; unknown names stay neutral',async()=>{
  assert.equal(await registerRole('Анна'),'Мама');
  assert.equal(await registerRole('Павел'),'Папа');
  assert.equal(await registerRole('Саша'),'Родитель');
});
