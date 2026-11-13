import test from 'node:test';
import assert from 'node:assert/strict';
import {matchCurrentSource} from '../app/current-child-identity.mjs';
import {planCurrentReport} from '../app/current-report-plan.mjs';

const today='2026-11-13';
const publication=(text,day=today)=>({
  publication_id:'synthetic_'+day,kind:'evening',report_date:day,
  normalized_text:text,submitted_at:Date.parse(day+'T18:00:00Z')
});
const child={child_id:'child_synthetic_1',registered_first_name:'Анфиса',surname:'Иванова'};
const parent={phone10:'9000000001',child_id:child.child_id};

test('late parent with exact full name can reuse an existing child identity',()=>{
  const result=matchCurrentSource({
    childName:'Анфиса Иванова',profiles:[parent],children:[child],
    publications:[],today
  });
  assert.equal(result.status,'linked');
  assert.equal(result.childId,child.child_id);
});

test('no current-day publication cannot establish a new child identity from old reports',()=>{
  const result=matchCurrentSource({
    childName:'Анфиса Иванова',profiles:[],children:[],
    publications:[publication('Анфиса: наблюдение','2026-11-11')],today
  });
  assert.equal(result.status,'pending');
});

test('late registration can use an explicit, unique surname prefix from the latest report within seven days',()=>{
  const source={...publication('Анфиса Ив.: наблюдение','2026-11-11'),publication_id:'pub_recent'};
  const result=matchCurrentSource({childName:'Анфиса Иванова',profiles:[],children:[],
    publications:[source],today});
  assert.equal(result.status,'new');
  assert.equal(result.publicationId,'pub_recent');
  assert.equal(result.blockIndex,0);
});

test('late registration does not use a bare historical name or a report older than seven days',()=>{
  const bare=matchCurrentSource({childName:'Анфиса Иванова',profiles:[],children:[],
    publications:[publication('Анфиса: наблюдение','2026-11-11')],today});
  assert.equal(bare.status,'pending');
  assert.equal(bare.reason,'recent-block-needs-surname-evidence');
  const stale=matchCurrentSource({childName:'Анфиса Иванова',profiles:[],children:[],
    publications:[publication('Анфиса Ив.: наблюдение','2026-11-01')],today});
  assert.equal(stale.status,'pending');
});

test('a reviewed or already-owned historical source block cannot auto-create a child',()=>{
  const reviewed={...publication('Анфиса Ив.: наблюдение','2026-11-11'),publication_id:'pub_reviewed',blockOwners:[{blocked:true}]};
  const result=matchCurrentSource({childName:'Анфиса Иванова',profiles:[],children:[],
    publications:[reviewed],today});
  assert.equal(result.status,'pending');
  assert.equal(result.reason,'block-already-reviewed');
});

test('unique pending block becomes deliverable after a verified parent link',()=>{
  const plan=planCurrentReport({
    kind:'evening',rawText:'Анфиса: спокойное настроение',
    profiles:[parent],children:[child],
    priorBlockOwners:[{pending:true,blocked:false,childId:''}]
  });
  assert.equal(plan.recipients.length,1);
  assert.equal(plan.recipients[0].childId,child.child_id);
  assert.match(plan.recipients[0].text,/спокойное настроение/);
});

test('historically blocked block stays blocked after a parent appears',()=>{
  const plan=planCurrentReport({
    kind:'evening',rawText:'Анфиса: наблюдение',
    profiles:[parent],children:[child],
    priorBlockOwners:[{pending:false,blocked:true,childId:''}]
  });
  assert.equal(plan.recipients.length,0);
});

test('same-name children without surname evidence cannot inherit each others reports',()=>{
  const other={child_id:'child_synthetic_2',registered_first_name:'Анфиса',surname:'Петрова'};
  const plan=planCurrentReport({
    kind:'evening',rawText:'Анфиса: наблюдение',
    profiles:[parent,{phone10:'9000000002',child_id:other.child_id}],
    children:[child,other],priorBlockOwners:[{pending:true,blocked:false,childId:''}]
  });
  assert.equal(plan.recipients.length,0);
});
