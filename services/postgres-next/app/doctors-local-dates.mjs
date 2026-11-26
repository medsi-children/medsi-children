import {createHash,randomUUID} from 'node:crypto';
import {validIsoDate} from './doctors-xlsx.mjs';

// Only explicit doctor edits are used. Never read the old Disk snapshots,
// create a Disk client, enqueue uploads or delete historic backup objects.
export function createDoctorsLocalDates({sql,greenwood,listPatients}){
  let prepared;
  const prepare=()=>prepared||=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS doctor_discharge_changes (
      id uuid PRIMARY KEY, patient_id text NOT NULL, version text NOT NULL,
      admission text, desired text NOT NULL, expected jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now())`;
  })().catch(error=>{prepared=null;throw error;});
  async function latest(client,id){
    const [[row]]=await client`SELECT id,admission,desired,status FROM doctor_discharge_changes
      WHERE patient_id=${id} ORDER BY created_at DESC,id DESC LIMIT 1`;
    return row;
  }
  function view(patient,row){
    const admission=validIsoDate(patient.episode)?patient.episode:null;
    const registry=admission&&validIsoDate(patient.registryDischarge)&&patient.registryDischarge>=admission
      ?patient.registryDischarge:null;
    const override=admission&&row?.admission===admission&&validIsoDate(row.desired)&&row.desired>=admission&&
      ['local','pending','conflict','synced'].includes(row.status)?row.desired:null;
    return {admission,discharge:override||registry,dischargeSource:override?'doctor':registry?'google':null,
      revision:createHash('sha256').update(JSON.stringify([patient.id,admission,registry,row?.id||null])).digest('hex'),
      syncConflict:false,editable:Boolean(patient.registry&&admission)};
  }
  async function dates(id,patient){
    if(!patient?.registry)return {admission:null,discharge:null,editable:false,syncConflict:false};
    await prepare();
    return view({...patient,id},await latest(sql,id));
  }
  async function enqueue(id,date,revision){
    if(typeof id!=='string'||!validIsoDate(date)||typeof revision!=='string')
      return {ok:false,status:400,message:'Укажите корректную дату выписки.'};
    if(!greenwood.configured)return {ok:false,status:503,message:'Реестр не подключён.'};
    const patient=(await listPatients({fresh:true})).find(p=>p.id===id);
    if(!patient?.registry)return {ok:false,status:404,message:'Пациент больше не в списке.'};
    if(!validIsoDate(patient.episode)||date<patient.episode)
      return {ok:false,status:400,message:'Проверьте дату поступления и выписки.'};
    await prepare();
    return sql.begin({isolation:'serializableReadWrite'},async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const row=await latest(tx,id);
      const current=view(patient,row);
      if(current.revision!==revision)
        return {ok:false,status:409,message:'Данные изменились. Обновите карточку пациента.'};
      if(current.dischargeSource==='doctor'&&current.discharge===date)return {ok:true};
      await tx`UPDATE doctor_discharge_changes SET status='superseded'
        WHERE patient_id=${id} AND status='pending'`;
      await tx`INSERT INTO doctor_discharge_changes(id,patient_id,version,admission,desired,expected,status)
        VALUES(${randomUUID()},${id},${revision},${patient.episode},${date},'{}'::jsonb,'local')`;
      return {ok:true};
    });
  }
  return {dates,enqueue,diagnostics:()=>({mode:'google-local',diskEnabled:false,registryConfigured:greenwood.configured,
    ...greenwood.diagnostics()})};
}
