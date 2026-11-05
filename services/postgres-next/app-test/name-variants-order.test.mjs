import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {mergeLegacyNameRows,orderLegacyNameVariants} from '../app/name-variants-order.mjs';
import {normalizeReportBaseline,captureSheetsNameVariants} from '../src/report-baseline.mjs';
const source=fs.readFileSync(new URL('../legacy-report-source/Медси бот.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('function addNameVariantRow_('),source.indexOf('// Do not access SpreadsheetApp',source.indexOf('function addNameVariantRow_(')));
function evaluate(rows){
 const ctx=vm.createContext({normalizeName_:s=>String(s).trim().toLowerCase().replace(/ё/g,'е'),dict:{},canon:{}});
 vm.runInContext(fn,ctx);for(const row of rows)ctx.addNameVariantRow_(ctx.dict,ctx.canon,...row);
 return JSON.parse(JSON.stringify({dict:ctx.dict,canon:ctx.canon}));
}
test('legacy repeated groups and shared aliases retain original Apps Script semantics after SQL reorder',()=>{
 const rows=[['Александр','Саша,Саня'],['Александра','Саша,Шура'],['Евгений','Женя'],['Александр','Шурик']];
 const merged=mergeLegacyNameRows(rows),order=merged.map(r=>r[0].toLowerCase());
 const captured=captureSheetsNameVariants(merged,{legacyOrder:order});
 const metadata=[{owner_key:'MIGRATION_NAME_VARIANT_ORDER_V1',record_json:JSON.stringify({baseKeys:order})}];
 const restored=orderLegacyNameVariants([...captured].reverse(),metadata).map(r=>[r.preferred_name,JSON.parse(r.variants_json).join(',')]);
 const original=evaluate(rows),actual=evaluate(restored);
 assert.deepEqual(actual.canon,original.canon);
 for(const k of Object.keys(original.dict))assert.deepEqual(new Set(actual.dict[k]),new Set(original.dict[k]));
 assert.throws(()=>captureSheetsNameVariants(merged),/ambiguous/);
 assert.throws(()=>captureSheetsNameVariants(merged,{legacyOrder:[...order].reverse()}),/ambiguous/);
});
test('migration order is persisted and malformed metadata fails closed',()=>{
 const result=normalizeReportBaseline({nameRows:[['Александр','Саша'],['Александра','Саша']],
 legacyNameVariantOrder:['александр','александра'],raw:[],heads:[],submissions:[],ownership:[]});
 assert.equal(result.report_ownership.length,1);
 assert.throws(()=>orderLegacyNameVariants([],[{owner_key:'MIGRATION_NAME_VARIANT_ORDER_V1',record_json:'{}'}]),/Invalid/);
});
