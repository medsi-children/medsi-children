import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeAppsScriptSource} from '../src/apps-script-normalize.mjs';
function fixture(){return {source:{preliminary:true,properties:{},sheets:{REPORTS:{values:[['','','','','','','','ID поступления (служебный)','Поколение профиля (служебный)'],['','','Тестолина','Примерова','','','','admission-a','mirror-generation']]},NAME_VARIANTS:{values:[['MAIN_NAME','NAME_VARIANTS'],['Тестолина','Тестуля']]}}},tables:{chat_profiles:[{child_admission_id:'admission-a',child_name:'Тестолина Примерова'}],report_publication_state:[]}};}
test('child spelling is joined by exact D1 admission and no parent identity comes from mirror',()=>{
 const {source,tables}=fixture();const result=normalizeAppsScriptSource(source,tables);
 assert.equal(result.roster.children.length,1);assert.equal(result.roster.admissions[0].admission_id,'admission-a');
 assert.equal(result.preliminary,true);assert.equal(result.reportBaseline.legacyNameVariantOrder[0],'тестолина');
 assert.equal(result.roster.children[0].created_at,null);
 source.sheets.REPORTS.values[1][7]='other-admission';assert.throws(()=>normalizeAppsScriptSource(source,tables),/unambiguously/);
});
test('same admission cannot silently change child spelling',()=>{
 const {source,tables}=fixture();source.sheets.REPORTS.values[1][2]='Другоеимя';
 assert.throws(()=>normalizeAppsScriptSource(source,tables),/unambiguously/);
});
