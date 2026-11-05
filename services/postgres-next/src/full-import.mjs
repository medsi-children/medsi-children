import {SCHEMA_SQL} from './schema-contract.mjs';
import {POSTGRES_STREAMS} from './postgres-manifests.mjs';
import {generateManifest,signManifestEnvelope} from '../app/migration-audit.mjs';
import {evaluateMigrationGate} from '../app/migration-gate.mjs';

const columns=new Map([...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)\s*\(([\s\S]*?)\n\);/g)]
  .map(match=>[match[1],[...match[2].matchAll(/^\s*([a-z_][a-z_0-9]*)\s+(TEXT|BIGINT|BOOLEAN|BYTEA)\b/gm)]
    .map(col=>({name:col[1],type:col[2]}))]));

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
  {hmacKey,explicitImport,freezeConfirmed,baselineImport=false}={}){
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
    const saved=[];
    let populated=false;
    for(const name of POSTGRES_STREAMS){
      const [rows]=await tx`SELECT * FROM public.${tx.identifier(name)}`;
      populated ||= rows.length>0;
      saved.push(generateManifest(name,rows,hmacKey));
    }
    if(populated){
      const current=signManifestEnvelope(sourceEnvelope.captureId,[...saved,destinationS3],hmacKey);
      if(!evaluateMigrationGate(sourceEnvelope,current,{hmacKey}).ready)
        throw new Error('Destination is populated and differs from capture.');
      return {alreadyImported:true,streams:POSTGRES_STREAMS.length};
    }
    for(const name of POSTGRES_STREAMS){
      const fields=columns.get(name).map(col=>col.name);
      for(const row of streams[name]){
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
