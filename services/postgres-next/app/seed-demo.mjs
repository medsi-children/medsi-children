import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectPostgresNext} from '../src/connection.mjs';
// The PostgreSQL CLI loads its client lazily. PostgreSQL production does not import PostgreSQL.

// Fictional parents and children only. NEVER seed a production or populated DB.
export const DEMO_CHILDREN=Object.freeze([
  {childId:'medsi-demo-child-01',firstName:'Алиса',surname:'Тестовая'},
  {childId:'medsi-demo-child-02',firstName:'Борис',surname:'Проверочный'}
]);
export const DEMO_PARENTS=Object.freeze([
  {phone:'9000000001',name:'Мария Тестовая',childIndex:0},
  {phone:'9000000002',name:'Алексей Тестовый',childIndex:0},
  {phone:'9000000003',name:'Ирина Проверочная',childIndex:1}
]);
const uint=n=>BigInt(n);

export async function seedSyntheticRoster({sql,now=()=>Date.now()}) {
  if(!sql?.begin)throw new Error('PostgreSQL client required for test seeding.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    const [markers]=await tx`SELECT bootstrap_id,status FROM stand_bootstrap_state
      WHERE bootstrap_id=${'synthetic_roster_v1'} LIMIT 1`;
    if(markers.length){
      if(markers.length===1&&markers[0].status==='complete'){
        return {children:DEMO_CHILDREN.length,parents:DEMO_PARENTS.length,alreadySeeded:true};
      }
      throw new Error('Synthetic seed marker is invalid; refusing to mutate the test database.');
    }
    // Safety fence: the fixture is only seeded into a wholly empty database.
    // These names/columns are static repository schema, never operator input.
    for(const [table,columns] of [
      ['children','child_id'],['admissions','admission_id'],
      ['parent_profiles','phone10'],['name_variants','base_key'],
      ['report_publication_head','kind'],['report_submissions','submission_id'],
      ['raw_reports','publication_id'],['report_ownership','owner_key'],
      ['parent_current_reports','phone10'],['parent_report_history','phone10'],
      ['chat_messages','message_key'],['chat_media','file_id'],
      ['chat_thread_state','phone10'],['chat_message_dedup','client_message_id'],
      ['chat_pins','phone10'],['chat_sessions','token_hash'],
      ['parent_auth_profiles','phone10'],['parent_passkeys','credential_id'],
      ['parent_auth_challenges','challenge_id'],['parent_deletion_queue','operation_id'],
      ['parent_registration_attempts','attempt_id'],['parent_access_requests','request_id'],
      ['push_subscriptions','subscription_id'],['push_outbox','event_id'],
      ['background_jobs','job_id'],['migration_state','stream_id']
    ]){
      const [rows]=await tx`SELECT ${sql.identifier(columns)} FROM ${sql.identifier(table)} LIMIT 1`;
      if(rows.length)throw new Error('Synthetic seed requires an entirely empty database.');
    }
    const timestamp=uint(now());
    for(const child of DEMO_CHILDREN){
      await tx.upsert`INSERT INTO children (child_id,registered_first_name,surname,created_at)
        VALUES (${child.childId},${child.firstName},${child.surname},${timestamp})`;
      await tx.upsert`INSERT INTO admissions
        (admission_id,child_id,status,admitted_at,discharged_at)
        VALUES (${'medsi-demo-admission-'+child.childId.slice(-2)},${child.childId},${'active'},${timestamp},${uint(0)})`;
    }
    for(const parent of DEMO_PARENTS){
      const child=DEMO_CHILDREN[parent.childIndex];
      const admissionId='medsi-demo-admission-'+child.childId.slice(-2);
      const gen='medsi-demo-gen-'+parent.phone;
      const userHandle=randomBytes(32).toString('base64url');
      const childName=child.firstName+' '+child.surname;
      await tx.upsert`INSERT INTO parent_profiles
        (phone10,parent_name,child_name,relationship,child_id,admission_id,
         profile_generation,child_genitive,created_at,updated_at)
        VALUES (${parent.phone},${parent.name},${childName},${'Родитель'},
          ${child.childId},${admissionId},${gen},${''},${timestamp},${timestamp})`;
      await tx.upsert`INSERT INTO parent_auth_profiles (phone10,user_handle,generation_id,created_at)
        VALUES (${parent.phone},${userHandle},${gen},${timestamp})`;
    }
    await tx.upsert`INSERT INTO stand_bootstrap_state (bootstrap_id,status,completed_at)
      VALUES (${'synthetic_roster_v1'},${'complete'},${timestamp})`;
    return {children:DEMO_CHILDREN.length,parents:DEMO_PARENTS.length,alreadySeeded:false};
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.env.MEDSI_NEXT_STAND!=='1'||process.env.MEDSI_NEXT_PG_ENABLED!=='1'||process.env.MEDSI_NEXT_SEED_DEMO!=='YES'){
    console.error('Synthetic PostgreSQL data seeding requires isolated stand plus explicit YES confirmation.');
    process.exitCode=2;
  }else{
    let driver;
    try{
      const connection=await connectPostgresNext(process.env);
      driver=connection.driver;
      const result=await seedSyntheticRoster(connection);
      console.log('Fictional PostgreSQL roster loaded:',result.children,'children,',result.parents,'parents.');
    }catch(_){
      console.error('Synthetic roster seed failed; nothing was imported from production.');
      process.exitCode=1;
    }finally{
      if(driver?.close)await driver.close().catch(()=>{});
    }
  }
}
