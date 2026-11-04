import test from 'node:test';
import assert from 'node:assert/strict';
import {connectPostgresNext} from '../src/connection.mjs';
import {captureRosterManifests,importRosterCapture} from '../src/roster-capture.mjs';
import {captureD1ReportManifests,importD1Reports} from '../src/d1-report-capture.mjs';
import {installSchema} from '../src/schema-cli.mjs';
import {prepareChatMediaImport,importChatMediaOwnership} from '../src/chat-media-copy.mjs';
import {captureD1ParentProfileManifest,importD1ParentProfiles} from '../src/d1-profile-capture.mjs';
import {generateManifest} from '../app/migration-audit.mjs';
import {captureD1ChatMessageManifest,importD1ChatMessages,
  captureD1ChatRelatedManifests,importD1ChatRelatedStreams} from '../src/d1-chat-capture.mjs';

const env=process.env;
const disposable=env.CI==='true' && env.PG_TEST_INSECURE_LOCAL==='1' &&
  env.PGHOST==='127.0.0.1' && env.PGDATABASE==='medsi_chat_import' && env.PGUSER==='medsi_ci';

test('D1 chat baseline imports once, verifies PostgreSQL data, and refuses mismatches',
  {skip:!disposable},async()=>{
    await installSchema({...env,PG_SCHEMA_CONFIRM:'CREATE_SCHEMA_IN_EMPTY_DATABASE'});
    const connection=await connectPostgresNext(env);
    try{
      const source=[{
        phone10:'9000000001',message_key:'fictional-message',client_message_id:'fictional-client',
        side:'parent',type:'image',text:'Синтетическая запись',file_id:'kv:fictional-image',
        reply_to_key:'',reaction:'',status:'active',created_at:1700000000000,
        edited_at:null,delete_after:null,read_by_parent:1,read_by_educator:0
      }];
      const hmacKey='synthetic-chat-import-test-key-123456789';
      const mapping=[{sourceFileId:source[0].file_id,fileId:'s3:chat/'+'a'.repeat(64)+'.png',
        phone10:source[0].phone10,bytes:23,sha256:'b'.repeat(64)}];
      const admissions=[{admission_id:'stay-1',child_id:'child-1',status:'active'}];
      const profiles=[{phone10:source[0].phone10,parent_name:'Тестовый родитель',child_name:'Тестолина',
        relationship:'Родитель',child_genitive:'',profile_generation:'generation-1',child_admission_id:''}];
      const links=[{phone10:profiles[0].phone10,profile_generation:'generation-1',admission_id:'stay-1'}];
      const profileOptions={hmacKey,explicitImport:true,freezeConfirmed:true,
        expectedManifest:captureD1ParentProfileManifest(profiles,links,admissions,hmacKey)};
      const importProfiles=()=>importD1ParentProfiles(connection.sql,profiles,links,admissions,profileOptions);
      await assert.rejects(importProfiles(),/roster/);
      const children=[{child_id:'child-1',registered_first_name:'Тестолина',surname:'Вымышленная',created_at:null}];
      const rosterAdmissions=[{...admissions[0],admitted_at:1700000000000,discharged_at:null},
        {admission_id:'stay-old',child_id:'child-1',status:'discharged',admitted_at:null,discharged_at:1600000000000}];
      const rosterOptions={...profileOptions,expectedManifests:captureRosterManifests(children,rosterAdmissions,hmacKey)};
      const importRoster=()=>importRosterCapture(connection.sql,children,rosterAdmissions,rosterOptions);
      assert.deepEqual(await importRoster(),{children:1,admissions:2,alreadyImported:false});
      assert.deepEqual(await importRoster(),{children:1,admissions:2,alreadyImported:true});
      assert.throws(()=>captureRosterManifests(children,[...rosterAdmissions,
        {...rosterAdmissions[0],admission_id:'another-active-stay'}],hmacKey),/ambiguous/);
      assert.deepEqual(await importProfiles(),{count:1,alreadyImported:false});
      assert.deepEqual(await importProfiles(),{count:1,alreadyImported:true});
      const current=[{phone10:profiles[0].phone10,kind:'morning',text:'Тестовый отчёт',
        version:'v2',read_version:'v1',updated_at:1700000000000,revision:2,publication_id:'pub-2',
        profile_generation:'generation-1',child_admission_id:'stay-1'}];
      const history=[{...current[0],profile_generation:'generation-old',child_admission_id:'stay-old',
        report_date:'2020-09-13',captured_at:1600000000000}];
      const oldLinks=[{...links[0],profile_generation:'generation-old',admission_id:'stay-old'}];
      const reportOptions={...profileOptions,expectedManifests:captureD1ReportManifests(current,history,links,oldLinks,hmacKey)};
      const importReports=()=>importD1Reports(connection.sql,current,history,links,oldLinks,reportOptions);
      assert.deepEqual(await importReports(),{parent_current_reports:1,parent_report_history:1});
      assert.deepEqual(await importReports(),{parent_current_reports:1,parent_report_history:1});
      const plan=prepareChatMediaImport(source,mapping);
      const rows=plan.messages;
      const options={hmacKey,explicitImport:true,freezeConfirmed:true,
        expectedManifest:captureD1ChatMessageManifest(rows,hmacKey)};
      await assert.rejects(importD1ChatMessages(connection.sql,rows,{...options,freezeConfirmed:false}),/approval/);
      assert.deepEqual(await importD1ChatMessages(connection.sql,rows,options),{count:1,alreadyImported:false});
      assert.deepEqual(await importD1ChatMessages(connection.sql,rows,options),{count:1,alreadyImported:true});
      const mediaOptions={...options,expectedManifest:generateManifest('chat_media',plan.chatMedia,hmacKey)};
      assert.deepEqual(await importChatMediaOwnership(connection.sql,source,mapping,mediaOptions),
        {count:1,alreadyImported:false});
      assert.deepEqual(await importChatMediaOwnership(connection.sql,source,mapping,mediaOptions),
        {count:1,alreadyImported:true});
      const pins=[{phone10:rows[0].phone10,bucket:'unread',updated_at:1700000000001}];
      const relatedOptions={...options,expectedManifests:captureD1ChatRelatedManifests(rows,pins,hmacKey)};
      const counts={chat_thread_state:1,chat_message_dedup:1,chat_pins:1};
      assert.deepEqual(await importD1ChatRelatedStreams(connection.sql,rows,pins,relatedOptions),counts);
      assert.deepEqual(await importD1ChatRelatedStreams(connection.sql,rows,pins,relatedOptions),counts);
      const changed=[{...rows[0],text:'Другая синтетическая запись'}];
      await assert.rejects(importD1ChatMessages(connection.sql,changed,options),/manifest mismatch/);
      await assert.rejects(importD1ChatMessages(connection.sql,changed,{...options,
        expectedManifest:captureD1ChatMessageManifest(changed,hmacKey)}),/differ from the baseline/);
    }finally{
      await connection.driver.close();
    }
  });
