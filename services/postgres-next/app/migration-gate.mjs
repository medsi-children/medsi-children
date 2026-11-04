import {compareManifests,REQUIRED_STREAMS,verifyManifestEnvelope} from './migration-audit.mjs';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const HEX=/^[a-f0-9]{64}$/;
function validSnapshot(value) {
  if(!value||typeof value!=='object'||!Array.isArray(value.manifests)||
    typeof value.captureId!=='string'||!/^[-A-Za-z0-9_]{12,120}$/.test(value.captureId)||
    typeof value.signature!=='string'||!HEX.test(value.signature)){
    throw new Error('Invalid migration manifest envelope.');
  }
  const seen=new Set();
  for(const item of value.manifests) {
    if(!item||!REQUIRED_STREAMS.includes(item.stream)||seen.has(item.stream)||
      !Number.isSafeInteger(item.count)||item.count<0||
      !Number.isSafeInteger(item.duplicateRows)||item.duplicateRows<0||
      item.duplicateRows>item.count||!HEX.test(item.digest)){
      throw new Error('Malformed or duplicate migration manifest stream.');
    }
    seen.add(item.stream);
  }
  return value;
}

// Input: aggregate keyed manifests only; source patient records never enter
// the cutover-gate process. Both captures MUST be frozen to the same write fence.
export function evaluateMigrationGate(source,destination,{hmacKey}={}) {
  const src=validSnapshot(source),dst=validSnapshot(destination);
  if(typeof hmacKey!=='string'||Buffer.byteLength(hmacKey,'utf8')<32||
    !verifyManifestEnvelope(src,hmacKey)||!verifyManifestEnvelope(dst,hmacKey)){
    return {ready:false,reason:'MANIFEST_SIGNATURE_INVALID',matched:0,
      expected:REQUIRED_STREAMS.length,findings:[]};
  }
  if(src.captureId!==dst.captureId){
    return {ready:false,reason:'CAPTURE_WINDOW_MISMATCH',matched:0,
      expected:REQUIRED_STREAMS.length,findings:[]};
  }
  const result=compareManifests(src.manifests,dst.manifests);
  const byName=arr=>new Map(arr.map(x=>[x.stream,x]));
  const original=byName(src.manifests),target=byName(dst.manifests);
  const findings=result.findings.map(f=>{
    const duplicateMismatch=original.get(f.stream)?.duplicateRows!==target.get(f.stream)?.duplicateRows;
    return {...f,status:f.status==='matched'&&duplicateMismatch?'mismatch':f.status};
  });
  const ready=findings.length===REQUIRED_STREAMS.length&&
    findings.every(f=>f.status==='matched');
  return {ready,reason:ready?'READY':'STREAM_MISMATCH',
    matched:findings.filter(f=>f.status==='matched').length,
    expected:REQUIRED_STREAMS.length,findings};
}
async function cli() {
  if(process.env.MEDSI_NEXT_MIGRATION_PREFLIGHT!=='YES'||process.argv.length!==4){
    throw new Error('Set explicit preflight confirmation and pass two manifest JSON paths.');
  }
  const [src,dst]=await Promise.all(process.argv.slice(2).map(async pathname=>{
    const contents=await readFile(pathname,'utf8');
    if(contents.length>1024*1024)throw new Error('Manifest file exceeds metadata-only size limit.');
    return JSON.parse(contents);
  }));
  const result=evaluateMigrationGate(src,dst,{hmacKey:process.env.MIGRATION_AUDIT_HMAC_KEY});
  // Only stream types and counts; never print names, phones, raw medical text or digests.
  console.log('PostgreSQL migration gate:',result.ready?'READY':'BLOCKED',
    '- streams matched',result.matched+'/'+result.expected);
  for(const item of result.findings)if(item.status!=='matched') {
    console.log('Stream check:',item.stream,item.status,
      'source count:',item.sourceCount??'-','destination count:',item.destinationCount??'-');
  }
  if(!result.ready)process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await cli();}catch(_){
    console.error('Migration comparison rejected: manifests incomplete, malformed or not permitted.');
    process.exitCode=2;
  }
}
