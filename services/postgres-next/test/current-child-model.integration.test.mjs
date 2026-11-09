import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {installSchema} from '../src/schema-cli.mjs';
import {readPostgresConfig} from '../src/connection.mjs';
import {connectPostgresNext} from '../src/connection.mjs';
import {createCurrentParentRegistrationService} from '../app/current-parent-registration.mjs';
import {createCurrentReportPublisher} from '../app/current-report-publications.mjs';
import {createCurrentParentReportReader} from '../app/current-parent-report-reader.mjs';
import {purgeCurrentRegisteredChild} from '../app/current-child-deletion.mjs';
import {checkCurrentChildSchema} from '../app/stand-server.mjs';
import {ensureCurrentChildColumns} from '../app/current-child-schema.mjs';

const enabled=process.env.CI==='true'&&process.env.MEDSI_CURRENT_IDENTITY_TEST==='1';
const raw=label=>'Степан '+label+' — Синтетическое наблюдение.';
test('admission-free end-to-end: parent timing, two parents, namesakes, therapy and deletion', {
  skip:enabled?false:'Dedicated disposable PostgreSQL 18 CI database only.'
},async()=>{
  const env={...process.env,PG_SCHEMA_CONFIRM:'CREATE_SCHEMA_IN_EMPTY_DATABASE'};
  await installSchema(env);
  const conn=await connectPostgresNext(env);
  const {sql}=conn;
  // The opt-in runtime can prepare old installations in-place without an
  // external SQL console. Repeating it must be safe and never drop tables.
  await ensureCurrentChildColumns(sql);
  await ensureCurrentChildColumns(sql);
  const [[legacyTable]]=await sql`SELECT to_regclass(${'public.admissions'}) IS NOT NULL AS retained`;
  assert.equal(legacyTable.retained,true);
  let clock=Date.now()-20000;
  const now=()=>clock;
  const publisher=createCurrentReportPublisher(sql);
  const registration=createCurrentParentRegistrationService({sql,now,
    sessions:{issueParent:async()=>({token:'synthetic_signed_session',expiresAt:clock+30000})}});
  const reader=createCurrentParentReportReader(sql,{now});
  const publish=async(kind,text,id)=>publisher.publish({
    kind,rawText:text,submissionId:id,authorId:'educator_ci_v2_0001',submittedAt:clock
  });
  const signup=async(phone,child,attempt)=>registration.register({
    phone,parentName:'Синтетический родитель',childName:child,attemptId:attempt
  });
  const phoneA='9991000011',phoneB='9991000022',phoneC='9991000033';
  try{
    assert.deepEqual(await checkCurrentChildSchema(sql),{ok:true});
    // The source is publishable even before ANY parent registered.
    const source='Степан — Синтетический текст утра.';
    const p0=await publish('morning',source,'ci_current_source0001');
    assert.equal(p0.status,'published');
    assert.equal(p0.recipients,0);
    const [noChildren]=await sql`SELECT child_id FROM children`;
    assert.equal(noChildren.length,0);
    const first=await signup('8'+phoneA,'Степан Сидоров','reg_current_first_0001');
    assert.equal(first.ok,true);
    const [[firstProfile]]=await sql`SELECT child_id FROM parent_profiles WHERE phone10=${phoneA}`;
    assert.ok(firstProfile.child_id);
    const firstReport=await reader.current(phoneA);
    assert.equal(firstReport.reports.find(r=>r.kind==='morning').text,
      'Степан: Синтетический текст утра.');
    assert.equal((await reader.history(phoneA)).reports.length,1);

    // Second guardian joins the same current registered child, no new child.
    const second=await signup('8'+phoneB,'Степан Сидоров','reg_current_second_0001');
    assert.equal(second.ok,true);
    const [[secondProfile]]=await sql`SELECT child_id FROM parent_profiles WHERE phone10=${phoneB}`;
    assert.equal(secondProfile.child_id,firstProfile.child_id);
    assert.equal((await reader.current(phoneB)).reports.find(r=>r.kind==='morning').text,
      'Степан: Синтетический текст утра.');
    const [onlyOne]=await sql`SELECT child_id FROM children`;
    assert.equal(onlyOne.length,1);

    // New namesake cannot inherit the first Stepan's bare authored heading.
    const namesake=await signup('8'+phoneC,'Степан Мерцалов','reg_current_namesake_0001');
    assert.equal(namesake.ok,true);
    const [[pending]]=await sql`SELECT child_id FROM parent_profiles WHERE phone10=${phoneC}`;
    assert.equal(pending.child_id,'');
    assert.deepEqual((await reader.current(phoneC)).reports.filter(r=>r.kind==='morning'),[]);

    // Educator explicitly distinguishes both surname prefixes.
    clock+=2000;
    const text='Степан Си. — Синтетический текст Сидорова.\n'+
      'Степан Ме. — Синтетический текст Мерцалова.';
    const p1=await publish('evening',text,'ci_current_source0002');
    assert.equal(p1.status,'published');
    assert.equal(p1.recipients,2); // first child's two guardians
    const firstEvening=(await reader.current(phoneA)).reports.find(r=>r.kind==='evening');
    const thirdEvening=(await reader.current(phoneC)).reports.find(r=>r.kind==='evening');
    assert.match(firstEvening.text,/Сидорова/);
    assert.doesNotMatch(firstEvening.text,/Мерцалова/);
    assert.match(thirdEvening.text,/Мерцалова/);
    assert.doesNotMatch(thirdEvening.text,/Сидорова/);
    const [[thirdProfile]]=await sql`SELECT child_id FROM parent_profiles WHERE phone10=${phoneC}`;
    assert.ok(thirdProfile.child_id&&thirdProfile.child_id!==firstProfile.child_id);

    // Latest shared group therapy remains available independently of child link.
    clock+=2000;
    const therapy='Групповая терапия: синтетическое занятие.\n\nВыводы.';
    await publish('psychology',therapy,'ci_current_therapy0001');
    assert.equal((await reader.current(phoneC)).reports.find(r=>r.kind==='psychology').text,therapy);

    // Deletion is triggered by removing registered parent profiles only.
    await sql`DELETE FROM parent_profiles WHERE phone10=${phoneA}`;
    assert.equal(await sql.begin({isolation:'serializableReadWrite'},tx=>
      purgeCurrentRegisteredChild(tx,firstProfile.child_id,clock)),false);
    await sql`DELETE FROM parent_profiles WHERE phone10=${phoneB}`;
    assert.equal(await sql.begin({isolation:'serializableReadWrite'},tx=>
      purgeCurrentRegisteredChild(tx,firstProfile.child_id,clock)),true);
    const [survivors]=await sql`SELECT child_id FROM children`;
    assert.deepEqual(survivors.map(x=>x.child_id),[thirdProfile.child_id]);
    const [[unaltered]]=await sql`SELECT raw_text FROM raw_reports
      WHERE publication_id=${p1.publicationId}`;
    assert.equal(unaltered.raw_text,text);

    // The contracting migration removes the physical admission table.
    const pool2=new pg.Pool(readPostgresConfig(env));
    try{
      await pool2.query(readFileSync(new URL('../sql/003_remove_hospital_admissions_MANUAL.sql',import.meta.url),'utf8'));
    }finally{await pool2.end()}
    const [[dropped]]=await sql`SELECT to_regclass(${'public.admissions'}) IS NULL AS removed`;
    assert.equal(dropped.removed,true);
    assert.equal((await reader.current(phoneC)).reports.find(r=>r.kind==='psychology').text,therapy);
    assert.deepEqual(await checkCurrentChildSchema(sql),{ok:true});
  }finally{await conn.driver.close()}
});
