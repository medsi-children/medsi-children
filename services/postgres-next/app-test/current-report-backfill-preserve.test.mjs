import test from 'node:test';
import assert from 'node:assert/strict';
import {createCurrentReportBackfill} from '../app/current-report-backfill.mjs';

test('history repair preserves an existing personalized current report text',async()=>{
  const now=Date.parse('2026-11-13T12:00:00Z'),written=[];
  const source={publication_id:'pub_synthetic_current',kind:'evening',report_date:'2026-11-13',
    normalized_text:'Анфиса: Исходное синтетическое наблюдение.',submitted_at:now-1000,revision:2n};
  const tx=async(strings,...values)=>{
    const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(q.startsWith('SELECT phone10,child_id FROM parent_profiles'))return [[{phone10:'9000000001',child_id:'child_synthetic_1'}]];
    if(q.startsWith('SELECT child_id,registered_first_name,surname FROM children'))return [[{child_id:'child_synthetic_1',registered_first_name:'Анфиса',surname:'Иванова'}]];
    if(q.startsWith('SELECT base_key,preferred_name,variants_json FROM name_variants'))return [[]];
    if(q.includes('FROM report_publication_head AS h'))return [[source]];
    if(q.startsWith('SELECT owner_key,record_json FROM report_ownership'))return [[{owner_key:'CURRENT_BLOCK_pub_synthetic_current_0',record_json:'{"childId":"child_synthetic_1","pending":false,"blocked":false}'}]];
    if(q.startsWith('SELECT child_id,publication_id,text FROM parent_current_reports'))return [[{child_id:'child_synthetic_1',publication_id:source.publication_id,text:'Персональная правка родителя.'}]];
    if(q.startsWith('SELECT publication_id FROM parent_report_history'))return [[]];
    throw new Error('Unexpected SQL '+q);
  };
  tx.upsert=async(strings,...values)=>{const q=strings.join('?').replace(/\s+/g,' ').trim();
    if(!q.startsWith('INSERT INTO parent_report_history'))throw new Error('Unexpected write '+q);
    written.push(values);return [[]];};
  const result=await createCurrentReportBackfill({begin:async(_options,fn)=>fn(tx)},{now:()=>now}).recover();
  assert.equal(result.backfilled,1);assert.equal(written.length,1);
  assert.equal(written[0][6],'Персональная правка родителя.');
});
