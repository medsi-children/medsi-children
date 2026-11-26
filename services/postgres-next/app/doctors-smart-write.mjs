import {createHash} from 'node:crypto';
import {allowedSmartPlanWritePath,diskVersion,verifyDiskBytes,diskWritePolicy} from './doctors-disk.mjs';
import {readPlanDates,updatePlanDischarge} from './doctors-xlsx.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const keyFor=(id,target)=>'doctor-plan-backups/'+hash(JSON.stringify([id,target.path,target.version]))+'.xlsx';
const samePaths=(a,b)=>a.length===b.length&&a.every(x=>b.some(y=>y.path===x.path));
export function smartWritePolicy(env,storage){
  if(env.DOCTORS_DISK_SMART_WRITE_ENABLED!=='1'||typeof storage?.removeObject!=='function')return null;
  const p=diskWritePolicy({...env,DOCTORS_DISK_WRITE_ENABLED:'1'},storage);
  return p?.mode==='production'?{...p,scope:hash('smart-v1:'+p.scope)}:null;
}
export function createDoctorsSmartWrite({sql,policy,storage,source,root}){
  let prepared;
  const prepare=()=>prepared||=(async()=>{
    await sql`CREATE TABLE IF NOT EXISTS doctor_smart_write_jobs (
      id uuid PRIMARY KEY, patient_id text NOT NULL, admission text NOT NULL,
      desired text NOT NULL, scope text NOT NULL, targets jsonb NOT NULL,
      status text NOT NULL, cleanup_done boolean NOT NULL DEFAULT false)`;
  })().catch(error=>{prepared=null;throw error;});
  async function status(client,id){
    if(!id)return null;
    const [[job]]=await client`SELECT status,scope FROM doctor_smart_write_jobs WHERE id=${id}`;
    return job?(policy&&job.scope===policy.scope?job.status:job.status==='synced'?'synced':'needsReview'):null;
  }
  async function enqueue(tx,id,patient,date,plan){
    if(!policy)return;
    await tx`UPDATE doctor_smart_write_jobs SET status='superseded'
      WHERE patient_id=${patient.id} AND status IN ('pending','needsReview','conflict')`;
    const targets=plan?.targets||[];
    const ready=plan&&plan.writeReady&&targets.length>0;
    await tx`INSERT INTO doctor_smart_write_jobs(id,patient_id,admission,desired,scope,targets,status)
      VALUES(${id},${patient.id},${patient.episode},${date},${policy.scope},${JSON.stringify(ready?targets:[])}::jsonb,${ready?'pending':'needsReview'})`;
  }
  async function run(patient,plan,owns,stillCurrent){
    if(!policy)return;
    await prepare();
    await sql.begin({isolation:'serializableReadWrite'},async tx=>{
      const [[lock]]=await tx`SELECT pg_try_advisory_xact_lock(hashtext(${patient.id})) AS owned`;
      if(!lock.owned)return;
      const [[job]]=await tx`SELECT j.* FROM doctor_smart_write_jobs j JOIN doctor_discharge_changes c ON c.id=j.id
        WHERE j.patient_id=${patient.id} AND j.scope=${policy.scope} AND j.status='pending'
        AND c.id=(SELECT id FROM doctor_discharge_changes WHERE patient_id=${patient.id} ORDER BY created_at DESC,id DESC LIMIT 1)
        LIMIT 1`;
      if(!job)return;
      const conflict=()=>tx`UPDATE doctor_smart_write_jobs SET status='conflict' WHERE id=${job.id}`;
      if(patient.episode!==job.admission||job.desired<job.admission)return conflict();
      if(!plan.writeReady)return;
      if(!samePaths(job.targets,plan.targets))return conflict();
      const staged=[];
      for(const target of job.targets){
        if(!allowedSmartPlanWritePath(root,target.path))return conflict();
        const current=plan.targets.find(t=>t.path===target.path);
        const bytes=await source.download(target.path);
        const version=diskVersion(await source.stat(target.path));
        if(version!==current.version||!verifyDiskBytes(bytes,version))return;
        const dates=readPlanDates(bytes);
        if(!owns(dates.patient)||dates.admission!==job.admission)return conflict();
        if(dates.discharge===job.desired)continue;
        if(version!==target.version||dates.discharge!==target.discharge)return conflict();
        let next;
        try{next=updatePlanDischarge(bytes,job.desired,{allowNative:true});}catch{return conflict();}
        staged.push({target,bytes,next});
      }
      for(const entry of staged){
        const key=keyFor(job.id,entry.target);
        if(!await storage.hasObject(key))await storage.putBuffer(key,entry.bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',{ifAbsent:true});
        if(await storage.sha256Object(key)!==hash(entry.bytes))throw Error('Temporary backup verification failed');
        const manifest=Buffer.from(JSON.stringify({operationId:job.id,path:entry.target.path,backupKey:key,
          originalSha256:hash(entry.bytes),replacementSha256:hash(entry.next)}));
        if(!await storage.hasObject(key+'.json'))await storage.putBuffer(key+'.json',manifest,'application/json',{ifAbsent:true});
        if(await storage.sha256Object(key+'.json')!==hash(manifest))throw Error('Temporary manifest verification failed');
      }
      for(const entry of staged){
        if(!await stillCurrent())return;
        if(diskVersion(await source.stat(entry.target.path))!==entry.target.version)return;
        await source.upload(entry.target.path,entry.next);
        if(hash(await source.download(entry.target.path))!==hash(entry.next))throw Error('Upload verification failed');
      }
      for(const target of job.targets){
        if(!await stillCurrent())return;
        const bytes=await source.download(target.path);
        if(!verifyDiskBytes(bytes,diskVersion(await source.stat(target.path))))return;
        const dates=readPlanDates(bytes);
        if(!owns(dates.patient)||dates.admission!==job.admission||dates.discharge!==job.desired)return conflict();
      }
      await tx`UPDATE doctor_smart_write_jobs SET status='synced' WHERE id=${job.id}`;
    });
  }
  async function cleanup(){
    if(!policy)return;
    await prepare();
    const [jobs]=await sql`SELECT id,targets FROM doctor_smart_write_jobs
      WHERE status='synced' AND scope=${policy.scope} AND cleanup_done=false LIMIT 50`;
    for(const job of jobs){
      for(const target of job.targets){
        const key=keyFor(job.id,target);
        if(await storage.removeObject(key)!==true||await storage.removeObject(key+'.json')!==true)throw Error('Temporary cleanup failed');
      }
      await sql`UPDATE doctor_smart_write_jobs SET cleanup_done=true WHERE id=${job.id}`;
    }
  }
  return {prepare,enqueue,status,run,cleanup,enabled:Boolean(policy)};
}
