import {generateManifest} from '../app/migration-audit.mjs';
import {normalizeVariantRow} from '../app/name-variants-store.mjs';

const kinds=new Set(['morning','evening','psychology']);
const invalid=()=>{throw new Error('Invalid or ambiguous report baseline.');};
const str=value=>typeof value==='string'&&!value.includes('\0');
const required=value=>str(value)&&value.trim().length>0;
function integer(value){
  if((typeof value!=='string'&&typeof value!=='number')||
     !/^(0|[1-9]\d{0,15})$/.test(String(value))||!Number.isSafeInteger(Number(value)))invalid();
  return String(value);
}

export function captureSheetsNameVariants(rows,{legacyOrder}={}){
  if(!Array.isArray(rows))invalid();
  const owners=new Set(),baseKeys=new Set();
  const groups=[];
  for(const row of rows){
    if(!Array.isArray(row))invalid();
    if(row.every(value=>value==null||value===''))continue;
    if(!required(row[0])||!(row[1]==null||str(row[1])))invalid();
    const variants=String(row[1]??'').split(/[,;\n]/).map(value=>value.trim()).filter(Boolean);
    const normalized=normalizeVariantRow({preferredName:row[0],variants});
    if(baseKeys.has(normalized.baseKey))invalid();
    baseKeys.add(normalized.baseKey);
    for(const name of normalized.variants){
      const key=name.toLocaleLowerCase('ru').replace(/ё/g,'е');
      if(owners.has(key)&&!legacyOrder)invalid();
      owners.add(key);
    }
    groups.push({base_key:normalized.baseKey,preferred_name:normalized.preferredName,
      variants_json:JSON.stringify(normalized.variants),updated_at:null});
  }
  if(legacyOrder&&(!Array.isArray(legacyOrder)||legacyOrder.length!==groups.length||
    groups.some((row,i)=>row.base_key!==legacyOrder[i])))invalid();
  return groups;
}

function unique(rows,key,convert){
  if(!Array.isArray(rows))invalid();
  const seen=new Set();
  return rows.map(row=>{
    if(!row||!required(row[key])||seen.has(row[key]))invalid();
    seen.add(row[key]);
    return convert(row);
  });
}

export function normalizeReportBaseline({nameRows,raw,heads,submissions,ownership,legacyNameVariantOrder}={}){
  if(!Array.isArray(ownership))invalid();
  const rawReports=unique(raw,'publication_id',row=>{
    if(!kinds.has(row.kind)||!required(row.raw_text)||!str(row.normalized_text)||
       !required(row.author_id)||typeof row.report_date!=='string'||
       !/^\d{4}-\d{2}-\d{2}$/.test(row.report_date))invalid();
    const parsed=new Date(row.report_date+'T00:00:00Z');
    if(!Number.isFinite(parsed.valueOf())||parsed.toISOString().slice(0,10)!==row.report_date)invalid();
    return {publication_id:row.publication_id,kind:row.kind,report_date:row.report_date,
      raw_text:row.raw_text,normalized_text:row.normalized_text,author_id:row.author_id,
      submitted_at:integer(row.submitted_at),revision:integer(row.revision)};
  });
  const byPublication=new Map(rawReports.map(row=>[row.publication_id,row]));
  function linked(row){
    const publication=byPublication.get(row.publication_id);
    const revision=integer(row.revision),submitted_at=integer(row.submitted_at);
    if(!publication||publication.kind!==row.kind||publication.revision!==revision||
       publication.submitted_at!==submitted_at)invalid();
    return {kind:row.kind,publication_id:row.publication_id,revision,submitted_at};
  }
  const reportHeads=unique(heads,'kind',linked);
  for(const row of rawReports){
    const head=reportHeads.find(item=>item.kind===row.kind);
    if(!head||BigInt(head.revision)<BigInt(row.revision)||
       (head.revision===row.revision&&head.publication_id!==row.publication_id))invalid();
  }
  return {
    name_variants:captureSheetsNameVariants(nameRows,{legacyOrder:legacyNameVariantOrder}),
    raw_reports:rawReports,
    report_publication_head:reportHeads,
    report_submissions:unique(submissions,'submission_id',row=>{
      if(typeof row.payload_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.payload_hash))invalid();
      return {submission_id:row.submission_id,payload_hash:row.payload_hash,...linked(row)};
    }),
    report_ownership:unique([...(ownership||[]),...(legacyNameVariantOrder?[{owner_key:'MIGRATION_NAME_VARIANT_ORDER_V1',record_json:JSON.stringify({baseKeys:legacyNameVariantOrder}),updated_at:'0'}]:[])],'owner_key',row=>{
      if(!str(row.record_json))invalid();
      let record;
      try{record=JSON.parse(row.record_json);}catch(_){invalid();}
      if(!record||typeof record!=='object'||Array.isArray(record))invalid();
      return {owner_key:row.owner_key,record_json:row.record_json,updated_at:integer(row.updated_at)};
    })
  };
}

export function captureReportBaselineManifests(input,hmacKey){
  return Object.entries(normalizeReportBaseline(input))
    .map(([stream,rows])=>generateManifest(stream,rows,hmacKey));
}

export async function importReportBaseline(sql,input,
  {hmacKey,expectedManifests,explicitImport,freezeConfirmed}={}){
  if(explicitImport!==true||freezeConfirmed!==true)throw new Error('Explicit frozen report baseline approval required.');
  const streams=Object.entries(normalizeReportBaseline(input));
  const expected=new Map(streams.map(([name,rows])=>[name,generateManifest(name,rows,hmacKey)]));
  if(!Array.isArray(expectedManifests)||expectedManifests.length!==expected.size||
     [...expected].some(([name,item])=>!expectedManifests.some(manifest=>manifest?.stream===name &&
       manifest.digest===item.digest&&manifest.count===item.count&&manifest.duplicateRows===item.duplicateRows))){
    throw new Error('Report baseline manifests mismatch.');
  }
  return sql.begin({},async tx=>{
    await tx`LOCK TABLE public.name_variants, public.raw_reports, public.report_publication_head,
      public.report_submissions, public.report_ownership IN SHARE ROW EXCLUSIVE MODE`;
    const counts={};
    for(const [name,rows] of streams){
      const table=tx.identifier(name);
      const [existing]=await tx`SELECT * FROM public.${table}`;
      if(!existing.length){
        for(const row of rows){
          const columns=Object.keys(row);
          const parts=['INSERT INTO public.',' (',...columns.slice(1).map(()=>', '),') VALUES (',
            ...columns.slice(1).map(()=>', '),')'];
          await tx(parts,table,...columns.map(column=>tx.identifier(column)),...Object.values(row));
        }
      }
      const [stored]=await tx`SELECT * FROM public.${table}`;
      if(generateManifest(name,stored,hmacKey).digest!==expected.get(name).digest){
        throw new Error('PostgreSQL report baseline differs from the capture.');
      }
      counts[name]=stored.length;
    }
    return counts;
  });
}
