import {SCHEMA_SQL} from './schema-contract.mjs';
import {POSTGRES_STREAMS} from './postgres-manifests.mjs';
import {generateManifest,signManifestEnvelope} from '../app/migration-audit.mjs';
import {evaluateMigrationGate} from '../app/migration-gate.mjs';

const columns=new Map([...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/g)]
  .map(match=>[match[1],[...match[2].matchAll(/^\s*([a-z_][a-z_0-9]*)\s+(TEXT|BIGINT|BOOLEAN|BYTEA)\b/gm)]
    .map(col=>({name:col[1],type:col[2]}))]));

const primaryKeys=new Map(SCHEMA_SQL.split('CREATE TABLE IF NOT EXISTS ').slice(1).map(block=>[
  block.slice(0,block.indexOf(' ')),block.split('PRIMARY KEY (')[1].split(')')[0].split(',').map(k=>k.trim())
]));

function validateRows(stream,rows){
  if(!Array.isArray(rows))throw new Error('Missing import stream.');
  const fields=columns.get(stream);
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==fields.length)
      throw new Error('Import row does not match schema.');
    for(const {name,type} of fields){
      if(!Object.hasOwn(row,name))throw new Error('Import column missing.');
      const value=row[name];
      if(value===null)continue;
      const valid=type==='TEXT'?typeof value==='string'&&!value.includes('\0')
        :type==='BOOLEAN'?typeof value==='boolean'
        :type==='BYTEA'?value instanceof Uint8Array
        :typeof value==='string'&&/^-?(0|[1-9][0-9]*)$/.test(value)&&
          BigInt(value)>=-9223372036854775808n&&BigInt(value)<=9223372036854775807n;
      if(!valid)throw new Error('Import column type invalid.');
    }
  }
}

// Input must already be normalized by the source-specific capture modules.
// No HTTP route: execute only inside the approved migration environment.
// S3 objects remain in the existing bucket; destinationS3 is a fresh read-only
// inventory, not the source manifest copied without checking the objects.
export async function importFullCapture(sql,streams,sourceEnvelope,destinationS3,
  {hmacKey,explicitImport,freezeConfirmed,baselineImport=false,previousEnvelope}={}){
  if(explicitImport!==true||(freezeConfirmed!==true&&baselineImport!==true))
    throw new Error('Explicit frozen full import required.');
  if(!streams||Object.keys(streams).length!==POSTGRES_STREAMS.length||
      POSTGRES_STREAMS.some(name=>!Object.hasOwn(streams,name)))
    throw new Error('All normalized PostgreSQL streams required.');
  for(const name of POSTGRES_STREAMS)validateRows(name,streams[name]);
  const manifests=POSTGRES_STREAMS.map(name=>generateManifest(name,streams[name],hmacKey));
  const candidate=signManifestEnvelope(sourceEnvelope?.captureId,[...manifests,destinationS3],hmacKey);
  if(!evaluateMigrationGate(sourceEnvelope,candidate,{hmacKey}).ready)
    throw new Error('Signed source capture or S3 inventory mismatch.');

  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    // Lock every user table before checking emptiness. Concurrent writers either
    // precede this snapshot or wait; an error rolls back the entire import.
    for(const name of POSTGRES_STREAMS)
      await tx`LOCK TABLE public.${tx.identifier(name)} IN ACCESS EXCLUSIVE MODE`;
    const saved=[],existingRows=new Map();
    let populated=false;
    for(const name of POSTGRES_STREAMS){
      const [rows]=await tx`SELECT * FROM public.${tx.identifier(name)}`;
      existingRows.set(name,rows);
      populated ||= rows.length>0;
      saved.push(generateManifest(name,rows,hmacKey));
    }
    const unchanged=new Set(),insertRows=new Map(POSTGRES_STREAMS.map(name=>[name,streams[name]]));
    if(populated){
      const current=signManifestEnvelope(sourceEnvelope.captureId,[...saved,destinationS3],hmacKey);
      if(evaluateMigrationGate(sourceEnvelope,current,{hmacKey}).ready)
        return {alreadyImported:true,streams:POSTGRES_STREAMS.length};
      if(freezeConfirmed!==true||baselineImport||!previousEnvelope)
        throw new Error('Destination is populated and differs from capture.');
      const priorS3=previousEnvelope.manifests?.find(m=>m.stream==='s3_objects');
      const priorActual=signManifestEnvelope(previousEnvelope.captureId,[...saved,priorS3],hmacKey);
      if(!evaluateMigrationGate(previousEnvelope,priorActual,{hmacKey}).ready)
        throw new Error('Destination changed since the approved baseline.');
      // Apply only changed rows under the same locks. No full reload and no
      // overwrite of any independent writes in the destination is permitted.
      for(const name of POSTGRES_STREAMS){
        if(saved.find(m=>m.stream===name).digest===manifests.find(m=>m.stream===name).digest){unchanged.add(name);continue;}
        const keys=primaryKeys.get(name);
        if(!keys?.length)throw new Error('Reconciliation primary key is unavailable.');
        const id=row=>JSON.stringify(keys.map(k=>row[k]));
        const previous=new Map(existingRows.get(name).map(row=>[id(row),row]));
        const wanted=new Map(streams[name].map(row=>[id(row),row]));
        for(const [key,row] of previous){
          const next=wanted.get(key);
          if(next&&generateManifest(name,[row],hmacKey).digest===generateManifest(name,[next],hmacKey).digest){wanted.delete(key);continue;}
          const chunks=['DELETE FROM public.',' WHERE '],values=[tx.identifier(name)];
          keys.forEach((field,index)=>{values.push(tx.identifier(field),row[field]);chunks.push(' = ',index===keys.length-1?'':' AND ');});
          await tx(chunks,...values);
        }
        // Only changed or new rows are inserted by the shared loop below.
        insertRows.set(name,[...wanted.values()]);
      }
    }

    for(const name of POSTGRES_STREAMS){
      if(unchanged.has(name))continue;
      const fields=columns.get(name).map(col=>col.name);
      for(const row of insertRows.get(name)){
        const chunks=['INSERT INTO public.'],values=[tx.identifier(name)];
        chunks.push(' (');
        fields.forEach((field,index)=>{values.push(tx.identifier(field));chunks.push(index===fields.length-1?') VALUES (':',');});
        fields.forEach((field,index)=>{values.push(row[field]);chunks.push(index===fields.length-1?')':',');});
        await tx(chunks,...values);
      }
    }
    const actual=[];
    for(const name of POSTGRES_STREAMS){
      const [rows]=await tx`SELECT * FROM public.${tx.identifier(name)}`;
      actual.push(generateManifest(name,rows,hmacKey));
    }
    const imported=signManifestEnvelope(sourceEnvelope.captureId,[...actual,destinationS3],hmacKey);
    if(!evaluateMigrationGate(sourceEnvelope,imported,{hmacKey}).ready)
      throw new Error('Imported data differs from signed capture.');
    return {alreadyImported:false,streams:POSTGRES_STREAMS.length};
  });
}
