import {createHash,randomUUID} from 'node:crypto';
import {createDoctorsDisk,diskVersion,isPlan,validDiskRoot,directDiskChild,verifyDiskBytes,testDiskWriteEnabled} from './doctors-disk.mjs';
import {readPlanDates,updatePlanDischarge,validIsoDate} from './doctors-xlsx.mjs';
import {fullName} from './doctors-roster.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const noAge=value=>fullName(value).replace(/[, ]+\d{1,2}(?:\s*(?:год|года|лет))?$/u,'').trim();
const identity=name=>{
  const words=noAge(name).split(' ');
  return (words.length===2 || words.length===3) &&
    words.every(word=>/^\p{L}{2,}(?:-\p{L}{2,})?$/u.test(word)) ? words : null;
};
function matches(name,parts){
  const words=identity(name);
  if(!words || (parts[2] && words[2] && parts[2]!==words[2]))return false;
  return (words[0]===parts[0] && words[1]===parts[1]) ||
    (words[0]===parts[1] && words[1]===parts[0]);
}
const moscowDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',
  day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date());

export function selectCurrentPlans(documents, today){
  const dated=documents.filter(plan=>plan.admission && plan.admission<=today);
  const admission=dated.map(plan=>plan.admission).sort().at(-1);
  const current=dated.filter(plan=>plan.admission===admission);
  current.sort((a,b)=>Number(b.final)-Number(a.final) || b.modified.localeCompare(a.modified) ||
    String(b.nameDate||'').localeCompare(String(a.nameDate||'')) ||
    String(b.discharge||'').localeCompare(String(a.discharge||'')) ||
    String(a.path||'').localeCompare(String(b.path||'')));
  return {admission,discharge:current[0]?.discharge||null,current};
}

export function createDoctorsPlans({sql,env,storage,listPatients,disk}) {
  const root=env.DOCTORS_DISK_ROOT;
  const source=validDiskRoot(root) ? (disk || (env.DOCTORS_DISK_TOKEN ? createDoctorsDisk(env.DOCTORS_DISK_TOKEN) : null)) : null;
  const write=Boolean(source && testDiskWriteEnabled(env,storage));
  if(env.DOCTORS_DISK_TEST_WRITE==='1' && !write)console.warn('MEDSI_DOCTORS_TEST_WRITE_DISABLED');
  let prepared;
  const prepare=()=>prepared ||= (async()=>{
    await sql`CREATE TABLE IF NOT EXISTS doctor_plan_snapshots (
      patient_id text PRIMARY KEY, snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS doctor_discharge_changes (
      id uuid PRIMARY KEY, patient_id text NOT NULL, version text NOT NULL,
      admission text, desired text NOT NULL, expected jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS doctor_discharge_single_pending
      ON doctor_discharge_changes (patient_id) WHERE status='pending'`;
  })().catch(error=>{prepared=null;throw error;});

  async function dates(id) {
    await prepare();
    const [[row]]=await sql`SELECT snapshot, (
      SELECT row_to_json(change) FROM (
        SELECT id,desired,status,admission FROM doctor_discharge_changes
        WHERE patient_id=${id} ORDER BY created_at DESC,id DESC LIMIT 1
      ) change
    ) AS pending FROM (SELECT ${id}::text AS id) needed
    LEFT JOIN doctor_plan_snapshots ON patient_id=needed.id`;
    const pending=row?.pending;
    const snapshot=row?.snapshot || {};
    const sameEpisode=pending && (!snapshot.admission || pending.admission===snapshot.admission || !pending.admission);
    return {
      admission:snapshot.admission || null,
      discharge:(sameEpisode && ['pending','conflict'].includes(pending.status) ? pending.desired : snapshot.discharge)||null,
      revision:(snapshot.version || '')+':'+(pending?.id||''),
      syncConflict:Boolean(sameEpisode && pending.status==='conflict'),
      editable:true
    };
  }

  async function enqueue(patientId,date,revision,confirmConflict=false) {
    if(!validIsoDate(date) || typeof revision!=='string')return {ok:false,status:400,message:'Укажите корректную дату выписки.'};
    await prepare();
    const registered=(await listPatients({fresh:true})).find(patient=>patient.id===patientId);
    if(!registered)return {ok:false,status:404,message:'Пациент больше не в списке.'};
    if(registered.registry && !registered.episode)return {ok:false,status:409,message:'Укажите дату поступления в реестре.'};
    return sql.begin({isolation:'serializableReadWrite'},async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext(${patientId}))`;
      const [[row]]=await tx`SELECT snapshot FROM doctor_plan_snapshots WHERE patient_id=${patientId}`;
      const snapshot=row?.snapshot || {};
      const [[latest]]=await tx`SELECT id,desired,status FROM doctor_discharge_changes
        WHERE patient_id=${patientId} ORDER BY created_at DESC,id DESC LIMIT 1`;
      if((snapshot.version||'')+':'+(latest?.id||'')!==revision)
        return {ok:false,status:409,message:'Планы изменились. Обновите карточку пациента.'};
      if(latest?.status==='conflict' && confirmConflict!==true)
        return {ok:false,status:409,message:'Подтвердите дату после проверки плана.'};
      const start=snapshot.admission || registered.episode;
      if(start && date<start)
        return {ok:false,status:400,message:'Дата выписки раньше даты госпитализации.'};
      if(latest?.status==='pending' && latest.desired===date)return {ok:true};
      if(latest?.status==='pending')await tx`UPDATE doctor_discharge_changes SET status='superseded' WHERE id=${latest.id}`;
      const expected=Object.fromEntries((snapshot.current||[]).map(plan=>[plan.path,plan.discharge]));
      await tx`INSERT INTO doctor_discharge_changes(id,patient_id,version,admission,desired,expected)
        VALUES(${randomUUID()},${patientId},${revision},${snapshot.admission||null},${date},${JSON.stringify(expected)}::jsonb)`;
      return {ok:true};
    });
  }

  async function scan(folder, parts, previous, today, episode) {
    const cached=new Map((previous?.documents||[]).map(doc=>[doc.path,doc]));
    const documents=[];
    let unsafe=false;
    for(const item of (await source.list(folder.path)).filter(isPlan)){
      if(!directDiskChild(folder.path,item)){unsafe=true;continue;}
      const version=diskVersion(item);
      if(!version){unsafe=true;continue;}
      const old=cached.get(item.path);
      let dates=old?.version===version ? old : null;
      if(!dates){
        const bytes=await source.download(item.path);
        const stable=await source.stat(item.path);
        if(diskVersion(stable)!==version || !verifyDiskBytes(bytes,version))throw new Error('Plan changed during scan');
        try {dates=readPlanDates(bytes);}
        catch{dates={invalid:true};}
      }
      if(dates.invalid || !(old?.version===version ? old.owned : dates.patient && matches(dates.patient,parts)))unsafe=true;
      const compactDate=/\b(\d{2})\.(\d{2})\.(\d{4})\b/u.exec(item.name);
      const nameDate=compactDate ? [compactDate[3],compactDate[2],compactDate[1]].join('-') : '';
      documents.push({path:item.path,version,modified:item.modified||'',nameDate:validIsoDate(nameDate)?nameDate:'',
        final:/итог/iu.test(item.name),admission:dates.admission||null,discharge:dates.discharge||null,
        owned:Boolean(dates.patient && matches(dates.patient,parts)),invalid:Boolean(dates.invalid)});
      // Retain only the fields needed for date synchronization.
      if(old?.version===version)documents.at(-1).owned=old.owned;
    }
    documents.sort((a,b)=>a.path.localeCompare(b.path));
    const selected=selectCurrentPlans(documents.filter(doc=>doc.owned && (!episode || doc.admission===episode)),today);
    const snapshot={...selected,documents,unsafe,
      folder:folder.path};
    snapshot.version=digest(JSON.stringify(snapshot));
    return snapshot;
  }

  async function writeAll(snapshot, operation, parts, stillCurrent) {
    if(snapshot.unsafe)return 'conflict';
    if(!snapshot.current.length)return 'pending';
    if(operation.desired<snapshot.admission ||
      (operation.admission && operation.admission!==snapshot.admission))return 'conflict';
    const expected=operation.expected || {};
    const staged=[];
    // Preflight all candidates before changing the first one.
    for(const plan of snapshot.current){
      if(plan.path.slice(0,plan.path.lastIndexOf('/'))!==snapshot.folder ||
        !snapshot.folder.startsWith(root.replace(/\/$/,'')+'/'))return 'conflict';
      const bytes=await source.download(plan.path);
      const version=diskVersion(await source.stat(plan.path));
      if(version!==plan.version || !verifyDiskBytes(bytes,version))return 'pending';
      const dates=readPlanDates(bytes);
      if(!matches(dates.patient,parts) || dates.admission!==snapshot.admission)return 'conflict';
      if(dates.discharge===operation.desired)continue;
      // An independent date edit must never be overwritten by a retry. A
      // newly discovered plan may be filled only when its discharge is blank.
      const known=Object.hasOwn(expected,plan.path);
      if(known ? dates.discharge!==expected[plan.path] : dates.discharge!==null)return 'conflict';
      staged.push({plan,bytes,next:updatePlanDischarge(bytes,operation.desired)});
    }
    for(const entry of staged){
      const key='doctor-plan-backups/'+digest(Buffer.from(operation.id+entry.plan.path+entry.plan.version))+'.xlsx';
      if(!await storage.hasObject(key)){
        await storage.putBuffer(key,entry.bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{ifAbsent:true});
      }
      if(await storage.sha256Object(key)!==digest(entry.bytes))throw new Error('Plan backup verification failed');
    }
    for(const entry of staged){
      if(stopped || !await stillCurrent())return 'pending';
      if (diskVersion(await source.stat(entry.plan.path))!==entry.plan.version)return 'pending';
      await source.upload(entry.plan.path,entry.next);
      const verified=await source.download(entry.plan.path);
      if(digest(verified)!==digest(entry.next))throw new Error('Plan upload verification changed');
    }
    return 'synced';
  }

  let working=false,timer,stopped=false;
  let failures=0;
  const configuredInterval=Number(env.DOCTORS_DISK_INTERVAL_MS || 300000);
  const interval=Number.isFinite(configuredInterval)?Math.max(60000,configuredInterval):300000;
  async function cycle(){
    if(working || stopped)return;
    working=true;
    try{
      await prepare();
      const patients=await listPatients({fresh:true});
      const folders=(await source.list(root)).filter(item=>item.type==='dir' && directDiskChild(root,item) && item.path!=='disk:/medsi-doctors-test');
      const today=moscowDay();
      let patientFailed=false;
      for(const patient of patients) {
        if(stopped)break;
        const parts=identity(patient.childName);
        if(!parts || (patient.registry && !patient.episode))continue;
        const matchesForPatient=folders.filter(folder=>matches(folder.name,parts));
        const duplicate=patients.some(other=>other.id!==patient.id && matches(other.childName,parts));
        try{await sql.begin({isolation:'serializableReadWrite'},async tx=>{
          const [[lock]]=await tx`SELECT pg_try_advisory_xact_lock(hashtext(${patient.id})) AS owned`;
          if(!lock.owned)return;
          const [[row]]=await tx`SELECT snapshot FROM doctor_plan_snapshots WHERE patient_id=${patient.id}`;
          const previous=row?.snapshot;
          const folder=matchesForPatient.length===1&&!duplicate?matchesForPatient[0]:null;
          const snapshot=folder ? await scan(folder,parts,previous,today,patient.episode) :
            {documents:[],current:[],admission:null,discharge:null,unsafe:matchesForPatient.length>1||duplicate};
          snapshot.version ||= digest(JSON.stringify(snapshot));
          if(snapshot.admission){
            await tx`UPDATE doctor_discharge_changes SET admission=${snapshot.admission}
              WHERE patient_id=${patient.id} AND status IN ('pending','conflict') AND admission IS NULL`;
          }
          if(write && folder && patient.episode){
            const [[operation]]=await tx`SELECT id,admission,desired,status,expected FROM doctor_discharge_changes
              WHERE patient_id=${patient.id} ORDER BY created_at DESC,id DESC LIMIT 1`;
            if(operation?.status==='pending'){
              // Recheck membership just before writing. A patient may have
              // left the roster during a long cycle.
              const stillCurrent=async()=>{
                const fresh=await listPatients({fresh:true});
                return fresh.some(p=>p.id===patient.id && p.episode===patient.episode &&
                  fullName(p.childName)===fullName(patient.childName)) &&
                  !fresh.some(p=>p.id!==patient.id && matches(p.childName,parts));
              };
              if(!await stillCurrent())return;
              const status=await writeAll(snapshot,operation,parts,stillCurrent);
              if(status==='synced'){
                const refreshed=await scan(folder,parts,snapshot,today,patient.episode);
                if(refreshed.unsafe || refreshed.admission!==snapshot.admission ||
                  snapshot.current.some(plan=>!refreshed.current.some(next=>next.path===plan.path)) ||
                  refreshed.current.some(plan=>plan.discharge!==operation.desired))throw new Error('Plan verification changed');
                Object.assign(snapshot,refreshed);
              }
              if(status!=='pending')await tx`UPDATE doctor_discharge_changes SET status=${status} WHERE id=${operation.id}`;
            }
          }
          await tx`INSERT INTO doctor_plan_snapshots(patient_id,snapshot) VALUES(${patient.id},${JSON.stringify(snapshot)}::jsonb)
            ON CONFLICT(patient_id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=now()`;
        });}catch{
          patientFailed=true;
          console.warn('MEDSI_DOCTORS_PATIENT_SYNC_UNAVAILABLE');
        }
      }
      failures=patientFailed?Math.min(failures+1,4):0;
    }catch{
      failures=Math.min(failures+1,4);
      console.warn('MEDSI_DOCTORS_DISK_SYNC_UNAVAILABLE');
    }finally{
      working=false;
      if(!stopped){timer=setTimeout(cycle,interval*2**failures);timer.unref();}
    }
  }
  return {dates,enqueue,start(){if(source)return cycle();},stop(){stopped=true;clearTimeout(timer);}};
}
