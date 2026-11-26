import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDoctorsDisk,DOCTORS_TEST_ROOT,validDiskRoot,directDiskChild,isPlan,diskVersion,verifyDiskBytes} from '../services/postgres-next/app/doctors-disk.mjs';
import {readPlanDates} from '../services/postgres-next/app/doctors-xlsx.mjs';

// Read-only diagnostics. Return counts and statuses only; never report file names,
// paths, dates, workbook contents, OAuth tokens or remote error payloads.
export async function probeDoctorsDisk({root,disk,sample=false}){
  if(!validDiskRoot(root) || (sample && root!==DOCTORS_TEST_ROOT))
    throw new Error('INVALID_PROBE_CONFIGURATION');
  const metadata=await disk.stat(root);
  if(metadata?.type!=='dir' || metadata.path!==root)throw new Error('ROOT_NOT_VERIFIED');
  const children=await disk.list(root);
  if(children.some(item=>!directDiskChild(root,item)))throw new Error('INVALID_ROOT_LISTING');
  const folders=children.filter(item=>item.type==='dir');
  const result={ok:true,readOnly:true,folders:folders.length,sampleVerified:false};
  if(!sample)return result;
  for(const folder of folders){
    const items=await disk.list(folder.path);
    if(items.some(item=>!directDiskChild(folder.path,item)))throw new Error('INVALID_SAMPLE_LISTING');
    const plan=items.find(isPlan);
    if(!plan)continue;
    const version=diskVersion(plan);
    const bytes=await disk.download(plan.path);
    if(!verifyDiskBytes(bytes,version) || diskVersion(await disk.stat(plan.path))!==version)
      throw new Error('SAMPLE_INTEGRITY_FAILED');
    const dates=readPlanDates(bytes);
    if(!dates.patient || !dates.admission)throw new Error('SAMPLE_FIELDS_MISSING');
    return {...result,sampleVerified:true};
  }
  throw new Error('NO_SAMPLE_PLAN');
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    const root=process.env.DOCTORS_DISK_ROOT;
    const token=process.env.DOCTORS_DISK_TOKEN;
    if(!token)throw new Error('MISSING_TOKEN');
    const result=await probeDoctorsDisk({root,disk:createDoctorsDisk(token),
      sample:process.env.DOCTORS_DISK_PROBE_SAMPLE==='1'});
    console.log(JSON.stringify(result));
  }catch{
    console.error('MEDSI_DOCTORS_DISK_PROBE_FAILED: check OAuth, configured root and test template');
    process.exitCode=1;
  }
}
