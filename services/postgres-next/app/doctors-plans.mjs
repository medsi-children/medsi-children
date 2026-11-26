import {createHash,randomUUID} from 'node:crypto';
import {createDoctorsDisk,diskVersion,isPlan,validDiskRoot,directDiskChild,verifyDiskBytes,diskWritePolicy,allowedPlanWritePath} from './doctors-disk.mjs';
import {readPlanDates,updatePlanDischarge,validIsoDate} from './doctors-xlsx.mjs';
import {fullName} from './doctors-roster.mjs';

// Diagnostic keys are fixed, never derived from names, remote bodies or raw exception text.
const diskCodes=new Set(['invalidTransferUrl','unexpectedTransferHost','apiNetwork','apiInvalidJson',
  'invalidListing','directoryLimit','fileTooLarge','downloadNetwork','downloadBody','downloadRedirectLimit',
  ...['api','download'].flatMap(stage=>['denied','notFound','rateLimited','serverError','httpError'].map(code=>stage+'_'+code))]);
const xlsxCodes=new Map([
  ['Missing or ambiguous plan sheet','xlsxSheet'],['Missing sheet relationship','xlsxRelationship'],
  ['Unsupported sheet path','xlsxSheetPath'],['Missing or oversized XLSX entry','xlsxEntry'],
  ['Unsupported XLSX XML','xlsxXml'],['Ambiguous plan field','xlsxAmbiguousField'],
  ['Unsupported plan field position','xlsxFieldPosition'],['Unsupported plan date cell','xlsxDateCell'],
  ['Missing plan date cell','xlsxDateMissing'],['Formula plan date cell','xlsxDateFormula'],
  ['Empty plan date cell','xlsxDateEmpty'],['Numeric date without calendar style','xlsxDateNumericStyle'],
  ['Invalid native Excel date','xlsxDateNativeInvalid'],
  ['Unsupported plan date range','xlsxDateRange'],['Invalid plan date','xlsxInvalidDate'],
  ['Invalid plan date order','xlsxDateOrder'],['Oversized XLSX','xlsxTooLarge']
]);
const increment=(counts,key)=>{counts[key]=(counts[key]||0)+1;};
const diskIssue=(issues,stage,error)=>increment(issues,stage+(diskCodes.has(error?.doctorDiskCode)?'_'+error.doctorDiskCode:'_failed'));
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
  const policy=diskWritePolicy(env,storage);
  const source=validDiskRoot(root) ? (disk || (env.DOCTORS_DISK_TOKEN ?
    createDoctorsDisk(env.DOCTORS_DISK_TOKEN,fetch,{writeRoot:policy?.root}) : null)) : null;
  const write=Boolean(source && policy);
  const scope=write?policy.scope:null;
  if((env.DOCTORS_DISK_TEST_WRITE==='1' || env.DOCTORS_DISK_WRITE_ENABLED==='1') && !write)
    console.warn('MEDSI_DOCTORS_DISK_WRITE_DISABLED');
  let prepared;
  const prepare=()=>prepared ||= (async()=>{
    await sql`CREATE TABLE IF NOT EXISTS doctor_plan_snapshots (
      patient_id text PRIMARY KEY, snapshot jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS doctor_discharge_changes (
      id uuid PRIMARY KEY, patient_id text NOT NULL, version text NOT NULL,
      admission text, desired text NOT NULL, expected jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`ALTER TABLE doctor_discharge_changes ADD COLUMN IF NOT EXISTS write_scope text`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS doctor_discharge_single_pending
      ON doctor_discharge_changes (patient_id) WHERE status='pending'`;
  })().catch(error=>{prepared=null;throw error;});

  async function dates(id) {
    await prepare();
    const [[row]]=await sql`SELECT snapshot, (
      SELECT row_to_json(change) FROM (
        SELECT id,desired,status,admission,write_scope FROM doctor_discharge_changes
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
      syncConflict:Boolean(sameEpisode && (pending.status==='conflict' ||
        (pending.status==='pending' && write && pending.write_scope!==scope))),
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
      const [[latest]]=await tx`SELECT id,desired,status,write_scope FROM doctor_discharge_changes
        WHERE patient_id=${patientId} ORDER BY created_at DESC,id DESC LIMIT 1`;
      if((snapshot.version||'')+':'+(latest?.id||'')!==revision)
        return {ok:false,status:409,message:'Планы изменились. Обновите карточку пациента.'};
      if((latest?.status==='conflict' || (latest?.status==='pending' && write && latest.write_scope!==scope)) && confirmConflict!==true)
        return {ok:false,status:409,message:'Подтвердите дату после проверки плана.'};
      const start=snapshot.admission || registered.episode;
      if(start && date<start)
        return {ok:false,status:400,message:'Дата выписки раньше даты госпитализации.'};
      if(latest?.status==='pending' && latest.desired===date && latest.write_scope===scope)return {ok:true};
      if(latest?.status==='pending')await tx`UPDATE doctor_discharge_changes SET status='superseded' WHERE id=${latest.id}`;
      const expected=Object.fromEntries((snapshot.current||[]).map(plan=>[plan.path,plan.discharge]));
      await tx`INSERT INTO doctor_discharge_changes(id,patient_id,version,admission,desired,expected,write_scope)
        VALUES(${randomUUID()},${patientId},${revision},${snapshot.admission||registered.episode||null},${date},${JSON.stringify(expected)}::jsonb,${scope})`;
      return {ok:true};
    });
  }

  async function scan(folder, parts, previous, today, episode, issues) {
    const cached=new Map((previous?.documents||[]).map(doc=>[doc.path,doc]));
    const documents=[];
    let unsafe=false;
    let items;
    try{items=(await source.list(folder.path)).filter(isPlan);}
    catch(error){diskIssue(issues,'folderList',error);throw error;}
    if(!items.length)increment(issues,'noXlsxPlans');
    let incomplete=false;
    for(const item of items){
      if(!directDiskChild(folder.path,item)){unsafe=true;increment(issues,'invalidPlanPath');continue;}
      const version=diskVersion(item);
      if(!version){unsafe=true;increment(issues,'missingHash');continue;}
      const old=cached.get(item.path);
      // Retry invalid or previously unowned files after parser improvements.
      const reuse=old?.version===version && old.owned && !old.invalid;
      let dates=reuse ? old : null;
      if(!dates){
        let bytes,stable;
        try{bytes=await source.download(item.path);}
        catch(error){diskIssue(issues,'download',error);unsafe=true;incomplete=true;continue;}
        try{stable=await source.stat(item.path);}
        catch(error){diskIssue(issues,'stat',error);unsafe=true;incomplete=true;continue;}
        if(diskVersion(stable)!==version){increment(issues,'changedDuringRead');unsafe=true;incomplete=true;continue;}
        if(!verifyDiskBytes(bytes,version)){increment(issues,'hashMismatch');unsafe=true;incomplete=true;continue;}
        try{dates=readPlanDates(bytes);}
        catch(error){increment(issues,xlsxCodes.get(error?.message)||'xlsxUnreadable');dates={invalid:true};}
      }
      if(!dates.invalid && !reuse && !dates.patient)increment(issues,'missingPatientField');
      if(!dates.invalid && !reuse && dates.patient && !matches(dates.patient,parts))increment(issues,'patientFieldMismatch');
      if(dates.invalid || !(reuse ? old.owned : dates.patient && matches(dates.patient,parts)))unsafe=true;
      const compactDate=/\b(\d{2})\.(\d{2})\.(\d{4})\b/u.exec(item.name);
      const nameDate=compactDate ? [compactDate[3],compactDate[2],compactDate[1]].join('-') : '';
      documents.push({path:item.path,version,modified:item.modified||'',nameDate:validIsoDate(nameDate)?nameDate:'',
        final:/итог/iu.test(item.name),admission:dates.admission||null,discharge:dates.discharge||null,
        owned:Boolean(dates.patient && matches(dates.patient,parts)),invalid:Boolean(dates.invalid)});
      // Retain only the fields needed for date synchronization.
      if(reuse)documents.at(-1).owned=old.owned;
    }
    documents.sort((a,b)=>a.path.localeCompare(b.path));
    const selected=selectCurrentPlans(documents.filter(doc=>doc.owned && (!episode || doc.admission===episode)),today);
    if(episode && documents.some(doc=>doc.owned && doc.admission!==episode) && !selected.current.length)increment(issues,'episodeMismatch');
    if(incomplete && !selected.current.length)throw new Error('Incomplete plan scan');
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
    if(Object.keys(expected).some(path=>!snapshot.current.some(plan=>plan.path===path)))return 'conflict';
    const staged=[];
    // Preflight all candidates before changing the first one.
    for(const plan of snapshot.current){
      if(!allowedPlanWritePath(root,plan.path) || plan.path.slice(0,plan.path.lastIndexOf('/'))!==snapshot.folder ||
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
      if(policy.mode==='production'){
        // Durable recovery metadata is written before the upload, outside the SQL transaction.
        // It remains available even after a crash or rollback. Never log the manifest.
        const manifest=Buffer.from(JSON.stringify({operationId:operation.id,path:entry.plan.path,
          backupKey:key,originalSha256:digest(entry.bytes),replacementSha256:digest(entry.next)}));
        const manifestKey=key+'.json';
        if(!await storage.hasObject(manifestKey))await storage.putBuffer(manifestKey,manifest,'application/json',{ifAbsent:true});
        if(await storage.sha256Object(manifestKey)!==digest(manifest))throw new Error('Plan recovery manifest verification failed');
      }
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
  let lastCycle=null,lastComplete=null;
  let counters={patients:0,matched:0,withPlans:0,unsafe:0,skipped:0,errors:0};
  let issueCounts={};
  const configuredInterval=Number(env.DOCTORS_DISK_INTERVAL_MS || 300000);
  const interval=Number.isFinite(configuredInterval)?Math.max(60000,configuredInterval):300000;
  async function cycle(){
    if(working || stopped)return;
    working=true;
    lastCycle=new Date().toISOString();
    const counts={patients:0,matched:0,withPlans:0,unsafe:0,skipped:0,errors:0};
    const issues={};
    let phase='database';
    try{
      await prepare();
      phase='registry';
      const patients=await listPatients({fresh:true});
      counts.patients=patients.length;
      phase='rootList';
      const rootItems=await source.list(root);
      const folders=rootItems.filter(item=>item.type==='dir' && directDiskChild(root,item) && item.path!=='disk:/medsi-doctors-test');
      phase='database';
      const today=moscowDay();
      let patientFailed=false;
      for(const patient of patients) {
        if(stopped)break;
        const parts=identity(patient.childName);
        if(!parts || (patient.registry && !patient.episode)){counts.skipped++;increment(issues,!parts?'unrecognizedPatientName':'missingRegistryAdmission');continue;}
        const matchesForPatient=folders.filter(folder=>matches(folder.name,parts));
        const duplicate=patients.some(other=>other.id!==patient.id && matches(other.childName,parts));
        const issuesBefore=Object.values(issues).reduce((a,b)=>a+b,0);
        try{await sql.begin({isolation:'serializableReadWrite'},async tx=>{
          const [[lock]]=await tx`SELECT pg_try_advisory_xact_lock(hashtext(${patient.id})) AS owned`;
          if(!lock.owned){counts.skipped++;return;}
          const [[row]]=await tx`SELECT snapshot FROM doctor_plan_snapshots WHERE patient_id=${patient.id}`;
          const previous=row?.snapshot;
          const folder=matchesForPatient.length===1&&!duplicate?matchesForPatient[0]:null;
          if(folder)counts.matched++;
          else increment(issues,duplicate||matchesForPatient.length>1?'ambiguousFolder':'noMatchingFolder');
          const snapshot=folder ? await scan(folder,parts,previous,today,patient.episode,issues) :
            {documents:[],current:[],admission:null,discharge:null,unsafe:matchesForPatient.length>1||duplicate};
          if(snapshot.current.length)counts.withPlans++;
          if(snapshot.unsafe)counts.unsafe++;
          snapshot.version ||= digest(JSON.stringify(snapshot));
          if(snapshot.admission){
            await tx`UPDATE doctor_discharge_changes SET admission=${snapshot.admission}
              WHERE patient_id=${patient.id} AND status IN ('pending','conflict') AND admission IS NULL`;
          }
          if(write && folder && patient.episode && (policy.mode==='test' || patient.registry===true)){
            const [[operation]]=await tx`SELECT id,admission,desired,status,expected,write_scope FROM doctor_discharge_changes
              WHERE patient_id=${patient.id} ORDER BY created_at DESC,id DESC LIMIT 1`;
            if(operation?.status==='pending' && operation.write_scope===scope){
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
                const refreshed=await scan(folder,parts,snapshot,today,patient.episode,issues);
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
        });}catch(error){
          if(Object.values(issues).reduce((a,b)=>a+b,0)===issuesBefore)
            diskIssue(issues,'patientProcessing',error);
          patientFailed=true;
          counts.errors++;
          console.warn('MEDSI_DOCTORS_PATIENT_SYNC_UNAVAILABLE');
        }
      }
      failures=patientFailed?Math.min(failures+1,4):0;
      if(!patientFailed && !stopped)lastComplete=new Date().toISOString();
    }catch(error){
      diskIssue(issues,phase,error);
      counts.errors++;
      failures=Math.min(failures+1,4);
      console.warn('MEDSI_DOCTORS_DISK_SYNC_UNAVAILABLE');
    }finally{
      counters=counts;issueCounts=issues;
      working=false;
      if(!stopped){timer=setTimeout(cycle,interval*2**failures);timer.unref();}
    }
  }
  return {dates,enqueue,diagnostics(){return {configured:Boolean(source),registryConfigured:Boolean(env.DOCTORS_GREENWOOD_SHEET_ID),
    mode:write?policy.mode:'read-only',running:working,lastCycle,lastComplete,failures,counters:{...counters},issues:{...issueCounts}};},
    start(){if(source)return cycle();},stop(){stopped=true;clearTimeout(timer);}};
}
