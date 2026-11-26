import {createHash,randomUUID} from 'node:crypto';
import {validIsoDate} from './doctors-xlsx.mjs';

// Explicit doctor edits override independently verified read-only Disk dates.
// Never read legacy snapshots or replay old Disk operations.
export function createDoctorsLocalDates({sql,greenwood,listPatients,diskRead}){
  const writer=diskRead?.writer;
  let prepared;
  const prepare=()=>prepared||=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS doctor_discharge_changes (
      id uuid PRIMARY KEY, patient_id text NOT NULL, version text NOT NULL,
      admission text, desired text NOT NULL, expected jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now())`;
    await writer?.prepare();
  })().catch(error=>{prepared=null;throw error;});
  async function latest(client,id){
    const [[row]]=await client`SELECT id,admission,desired,status FROM doctor_discharge_changes
      WHERE patient_id=${id} ORDER BY created_at DESC,id DESC LIMIT 1`;
    return row;
  }
  function view(patient,row,writeStatus,diskDisplay,livePlan){
    const admission=validIsoDate(patient.episode)?patient.episode:null;
    const registry=admission&&validIsoDate(patient.registryDischarge)&&patient.registryDischarge>=admission
      ?patient.registryDischarge:null;
    const override=admission&&row?.admission===admission&&validIsoDate(row.desired)&&row.desired>=admission&&
      ['local','pending','conflict','synced'].includes(row.status)?row.desired:null;
    const plan=diskDisplay?diskDisplay.dates.get(patient.id):livePlan;
    const verified=plan?.status==='verified'&&validIsoDate(plan.discharge)&&plan.discharge>=admission?plan.discharge:null;
    const candidate=plan?.status==='admissionMismatch'&&admission&&validIsoDate(plan.candidateDischarge)&&plan.candidateDischarge>=admission
      ?plan.candidateDischarge:null;
    return {admission,discharge:override||verified||candidate||registry,
      dischargeSource:override?'doctor':verified?(plan.kind==='preliminary'?'disk-preliminary':'disk'):candidate?'disk-candidate':registry?'google':null,
      planStatus:plan?.status||(diskRead?'checking':null),
      diskWriteStatus:override?(writeStatus||(writer?.enabled?'notQueued':null)):null,
      unverifiedPlans:plan?.unverified||0,
      revision:createHash('sha256').update(JSON.stringify([patient.id,admission,registry,verified,candidate,plan?.status||null,livePlan?.writeReady?livePlan.targets:[],row?.id||null,writeStatus])).digest('hex'),
      syncConflict:false,editable:Boolean(patient.registry&&admission)};
  }
  async function dates(id,patient,diskDisplay){
    if(!patient?.registry)return {admission:null,discharge:null,editable:false,syncConflict:false};
    await prepare();
    const row=await latest(sql,id);
    return view({...patient,id},row,await writer?.status(sql,row?.id),diskDisplay,
      diskRead?.get(id,patient.episode,diskDisplay?.key));
  }
  async function enqueue(id,date,revision){
    if(typeof id!=='string'||!validIsoDate(date)||typeof revision!=='string')
      return {ok:false,status:400,message:'Укажите корректную дату выписки.'};
    if(!greenwood.configured)return {ok:false,status:503,message:'Реестр не подключён.'};
    const patients=await listPatients({fresh:true});
    const patient=patients.find(p=>p.id===id);
    if(!patient?.registry)return {ok:false,status:404,message:'Пациент больше не в списке.'};
    if(!validIsoDate(patient.episode)||date<patient.episode)
      return {ok:false,status:400,message:'Проверьте дату поступления и выписки.'};
    const diskDisplay=await diskRead?.readDisplay?.(patients);
    await prepare();
    return sql.begin({isolation:'serializableReadWrite'},async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const row=await latest(tx,id);
      const writeStatus=await writer?.status(tx,row?.id);
      const livePlan=diskRead?.get(id,patient.episode,diskDisplay?.key);
      const current=view(patient,row,writeStatus,diskDisplay,livePlan);
      if(current.revision!==revision)
        return {ok:false,status:409,message:'Данные изменились. Обновите карточку пациента.'};
      if(current.dischargeSource==='doctor'&&current.discharge===date&&(!writer?.enabled||['pending','synced'].includes(writeStatus)))return {ok:true};
      await tx`UPDATE doctor_discharge_changes SET status='superseded'
        WHERE patient_id=${id} AND status='pending'`;
      const operationId=randomUUID();
      await tx`INSERT INTO doctor_discharge_changes(id,patient_id,version,admission,desired,expected,status)
        VALUES(${operationId},${id},${revision},${patient.episode},${date},'{}'::jsonb,'local')`;
      await writer?.enqueue(tx,operationId,patient,date,livePlan);
      return {ok:true};
    });
  }
  return {dates,enqueue,readDiskDisplay:patients=>diskRead?.readDisplay?.(patients),diagnostics:()=>({mode:writer?.enabled?'google-disk-write-local':diskRead?'google-disk-read-local':'google-local',
    diskEnabled:Boolean(diskRead?.diagnostics().enabled),registryConfigured:greenwood.configured,
    ...greenwood.diagnostics(),...(diskRead?{disk:diskRead.diagnostics()}: {})})};
}
