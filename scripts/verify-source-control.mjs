import {existsSync,readFileSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const required=[
  'server.js','services/postgres-next/app/stand-server.mjs',
  'services/postgres-next/app/report-engine.mjs',
  'services/postgres-next/sql/001_initial.sql',
  'services/postgres-next/legacy-report-source/report-rules.js',
  'services/postgres-next/legacy-report-source/report-names.js',
  'services/postgres-next/legacy-report-source/report-parser.js',
  'services/postgres-next/legacy-report-source/report-distribution.js',
  'services/postgres-next/legacy-report-source/report-admissions.js',
  'services/postgres-next/legacy-report-source/Медси бот.js',
  'tutors/report-validation.js','parents/full-web.js',
  'tutors/next-settings.js','chat-overlay/transport.js'
];
const errors=[];
for(const file of required){
  const full=resolve(root,file);
  if(!existsSync(full)||!statSync(full).isFile()||statSync(full).size===0)errors.push('Required file missing: '+file);
}
if(!errors.length){
  const browser=readFileSync(resolve(root,'tutors/report-validation.js'),'utf8');
  const bundled=readFileSync(resolve(root,'services/postgres-next/legacy-report-source/report-rules.js'),'utf8');
  if(browser!==bundled)errors.push('Browser and local report validation rules diverge.');
  const engine=readFileSync(resolve(root,'services/postgres-next/app/report-engine.mjs'),'utf8');
  if(!engine.includes("legacy-report-source/"))errors.push('Report engine no longer uses bundled report algorithms.');
}
if(errors.length){console.error(errors.join('\n'));process.exitCode=1;}
else console.log('OK — PostgreSQL app, bundled report rules and active website sources present.');
