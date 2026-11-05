import {createHash} from 'node:crypto';

export const D1_SOURCE_TABLES=Object.freeze([
  'chat_messages','chat_pins','chat_profiles','parent_access_requests',
  'parent_auth_challenges','parent_auth_profiles','parent_deletion_queue',
  'parent_passkeys','parent_registration_attempts','parent_registration_outbox',
  'report_current','report_inactivity_state','report_publication_state',
  'report_push_dedup','report_snapshots','report_state_import_runs','report_submission_queue'
]);
const canonical=value=>{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(value instanceof Uint8Array)return canonical([...value]);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
};
const fingerprint=rows=>createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex');
const reject=()=>{throw new Error('Frozen Cloudflare source capture failed or changed.');};

async function readD1(db){
  const schema=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all();
  if(schema.success===false||!Array.isArray(schema.results))reject();
  const names=schema.results.map(row=>row.name).sort();
  if(names.length!==D1_SOURCE_TABLES.length||names.some((name,i)=>name!==[...D1_SOURCE_TABLES].sort()[i]))reject();
  // D1 batch executes the fixed SELECT projections in one transaction.
  const batch=await db.batch(D1_SOURCE_TABLES.map(name=>db.prepare('SELECT * FROM '+name)));
  if(!Array.isArray(batch)||batch.length!==D1_SOURCE_TABLES.length||
      batch.some(result=>result.success===false||!Array.isArray(result.results)))reject();
  return Object.fromEntries(D1_SOURCE_TABLES.map((name,i)=>[name,batch[i].results]));
}

async function readKV(namespace,prefix){
  const entries=[],seen=new Set(),cursors=new Set();
  let cursor;
  for(let page=0;page<100;page++){
    const listed=await namespace.list({prefix,limit:1000,...(cursor?{cursor}:{})});
    if(!listed||!Array.isArray(listed.keys)||typeof listed.list_complete!=='boolean')reject();
    for(const item of listed.keys){
      if(typeof item.name!=='string'||!item.name.startsWith(prefix)||seen.has(item.name))reject();
      seen.add(item.name);
      const value=await namespace.get(item.name,'text');
      if(typeof value!=='string')reject();
      entries.push({key:item.name,value});
    }
    if(listed.list_complete)return entries;
    if(typeof listed.cursor!=='string'||!listed.cursor||cursors.has(listed.cursor))reject();
    cursors.add(listed.cursor);cursor=listed.cursor;
  }
  reject();
}

// Raw rows and KV keys must remain inside the approved migration runtime.
// A second independent read detects drift; it does not replace stopping all
// writers. No request handler or production mutation is installed by this module.
export async function captureFrozenCloudflareSources({db,pushKV,freezeConfirmed}={}){
  if(freezeConfirmed!==true||!db?.batch||!db?.prepare||!pushKV?.list||!pushKV?.get)
    throw new Error('Frozen D1 and push KV bindings are required.');
  try{
    const before=await readD1(db);
    const pushEntries=await readKV(pushKV,'sub:');
    const after=await readD1(db);
    const pushAfter=await readKV(pushKV,'sub:');
    if(D1_SOURCE_TABLES.some(name=>fingerprint(before[name])!==fingerprint(after[name]))||
        fingerprint(pushEntries)!==fingerprint(pushAfter))reject();
    return {tables:before,pushEntries};
  }catch(_){reject();}
}
