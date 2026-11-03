import {Uint64} from '@ydbjs/value/primitive';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {connectYdbNext} from './connection.mjs';

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
const uint=n=>new Uint64(BigInt(n));

export async function seedSyntheticRoster({sql,now=()=>Date.now()}) {
  if(!sql?.begin)throw new Error('YDB client required for test seeding.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    // Safety fence: no synthetic writes beside real existing parents or children.
    // Test database is expected to be totally new and empty.
    for(const [table,columns] of [
      ['children','child_id'],['admissions','admission_id'],
      ['parent_profiles','phone10'],['parent_auth_profiles','phone10'],
      ['raw_reports','publication_id'],['chat_messages','phone10']
    ]){
      const [rows]=await tx`SELECT ${sql.identifier(columns)} FROM ${sql.identifier(table)} LIMIT 1`;
      if(rows.length)throw new Error('Synthetic seed requires an entirely empty database.');
    }
    const timestamp=uint(now());
    for(const child of DEMO_CHILDREN){
      await tx`UPSERT INTO children (child_id,registered_first_name,surname,created_at)
        VALUES (${child.childId},${child.firstName},${child.surname},${timestamp})`;
      await tx`UPSERT INTO admissions
        (admission_id,child_id,status,admitted_at,discharged_at)
        VALUES (${'medsi-demo-admission-'+child.childId.slice(-2)},${child.childId},${'active'},${timestamp},${uint(0)})`;
    }
    for(const parent of DEMO_PARENTS){
      const child=DEMO_CHILDREN[parent.childIndex];
      const admissionId='medsi-demo-admission-'+child.childId.slice(-2);
      const gen='medsi-demo-gen-'+parent.phone;
      const userHandle=randomBytes(32).toString('base64url');
      const childName=child.firstName+' '+child.surname;
      await tx`UPSERT INTO parent_profiles
        (phone10,parent_name,child_name,relationship,child_id,admission_id,
         profile_generation,child_genitive,created_at,updated_at)
        VALUES (${parent.phone},${parent.name},${childName},${'Родитель'},
          ${child.childId},${admissionId},${gen},${''},${timestamp},${timestamp})`;
      await tx`UPSERT INTO parent_auth_profiles (phone10,user_handle,generation_id,created_at)
        VALUES (${parent.phone},${userHandle},${gen},${timestamp})`;
    }
    return {children:DEMO_CHILDREN.length,parents:DEMO_PARENTS.length};
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if(process.env.MEDSI_NEXT_STAND!=='1'||process.env.MEDSI_NEXT_SEED_DEMO!=='YES'){
    console.error('Synthetic YDB data seeding requires isolated stand plus explicit YES confirmation.');
    process.exitCode=2;
  }else{
    let driver;
    try{
      const connection=await connectYdbNext(process.env);
      driver=connection.driver;
      const result=await seedSyntheticRoster(connection);
      console.log('Fictional YDB roster loaded:',result.children,'children,',result.parents,'parents.');
    }catch(_){
      console.error('Synthetic roster seed failed; nothing was imported from production.');
      process.exitCode=1;
    }finally{
      if(driver?.destroy)await driver.destroy().catch(()=>{});
    }
  }
}
