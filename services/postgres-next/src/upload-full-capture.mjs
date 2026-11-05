import {open,stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const MAX=32*1024*1024;
const IMPORT_URL='https://medsi-children-medsi-children-de91.twc1.net/__migration/import';

export async function uploadFullCapture(path,{env=process.env,fetcher=fetch}={}){
  if(env.MEDSI_NEXT_MIGRATION_UPLOAD!=='YES'||env.MEDSI_NEXT_MIGRATION_FREEZE!=='YES')
    throw new Error('Explicit upload and source-freeze confirmation required.');
  const token=String(env.MEDSI_MIGRATION_IMPORT_TOKEN||'');
  if(token.length<32)throw new Error('Protected import credentials are unavailable.');
  const info=await stat(path);
  if(!info.isFile()||info.size<2||info.size>MAX||(info.mode&0o077)!==0)
    throw new Error('Capture file is outside the permitted size or local privacy mode.');
  const file=await open(path,'r');let contents;
  try{contents=await file.readFile('utf8');}finally{await file.close();}
  let packageData;
  try{packageData=JSON.parse(contents);}catch(_){throw new Error('Capture package is malformed.');}
  if(packageData?.preliminary===true||!packageData?.streams||!packageData?.envelope||!Array.isArray(packageData?.s3Objects))
    throw new Error('Capture package is incomplete.');
  const response=await fetcher(IMPORT_URL,{method:'POST',headers:{authorization:'Bearer '+token,
    'content-type':'application/json','x-medsi-migration-freeze':'confirmed',
    'x-medsi-migration-import':'confirmed'},body:contents,signal:AbortSignal.timeout(120000)});
  let result;
  try{result=await response.json();}catch(_){throw new Error('Import service returned an invalid response.');}
  if(!response.ok||result?.ok!==true)throw new Error('PostgreSQL rejected the full capture.');
  return {alreadyImported:result.alreadyImported===true,streams:result.streams,s3Objects:result.s3Objects};
}

async function cli(){
  if(process.argv.length!==3)throw new Error('Pass exactly one protected full-capture file.');
  const result=await uploadFullCapture(process.argv[2]);
  console.log('PostgreSQL full capture:',result.alreadyImported?'verified existing import':'imported',
    'streams:',result.streams,'S3 objects:',result.s3Objects);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await cli();}catch(_){
    console.error('Full-capture upload stopped: confirmation, package or protected destination check failed.');
    process.exitCode=2;
  }
}
