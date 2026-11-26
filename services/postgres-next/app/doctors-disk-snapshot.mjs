import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_AGE_MS=24*60*60*1000;

export function doctorRosterKey(patients){
  return digest(patients.map(p=>[p.id,p.childName,p.episode]).sort((a,b)=>a[0].localeCompare(b[0])));
}

// Presentation only. Keep file paths and versions in the live scanner, where
// ownership and the current file set must be checked before writing.
export function createDoctorsDiskSnapshot({sql,env,now}){
  const scope=digest(['doctor-disk-read-v1',env.DOCTORS_GREENWOOD_SHEET_ID,env.DOCTORS_DISK_ROOT,env.DOCTORS_DISK_TOKEN]);
  let prepared,local=null;
  const prepare=()=>prepared||=(sql`CREATE TABLE IF NOT EXISTS doctor_disk_read_snapshots (
    scope text PRIMARY KEY, roster_key text NOT NULL, scan_started bigint NOT NULL, dates jsonb NOT NULL)`
    .catch(error=>{prepared=null;throw error;}));

  async function read(rosterKey){
    if(sql){
      try{
        await prepare();
        const [[row]]=await sql`SELECT roster_key,scan_started,dates FROM doctor_disk_read_snapshots WHERE scope=${scope}`;
        if(row&&(!local||Number(row.scan_started)>=local.scanStarted))
          local={rosterKey:row.roster_key,scanStarted:Number(row.scan_started),dates:row.dates};
      }catch{return local?.rosterKey===rosterKey?local.dates:{};}
    }
    return local?.rosterKey===rosterKey?local.dates:{};
  }

  async function publish(rosterKey,scanStarted,dates){
    if(!local||scanStarted>local.scanStarted)local={rosterKey,scanStarted,dates};
    if(!sql)return;
    await prepare();
    await sql`INSERT INTO doctor_disk_read_snapshots(scope,roster_key,scan_started,dates)
      VALUES(${scope},${rosterKey},${scanStarted},${JSON.stringify(dates)}::jsonb)
      ON CONFLICT(scope) DO UPDATE SET roster_key=EXCLUDED.roster_key,
        scan_started=EXCLUDED.scan_started,dates=EXCLUDED.dates
      WHERE doctor_disk_read_snapshots.scan_started<EXCLUDED.scan_started`;
  }

  async function forRoster(patients){
    const key=doctorRosterKey(patients);
    const dates=await read(key);
    const cutoff=now()-MAX_AGE_MS;
    return {key,dates:new Map(Object.entries(dates).filter(([,value])=>value.checkedAt>=cutoff))};
  }
  return {read,publish,forRoster};
}
