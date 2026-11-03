'use strict';
// Seven-day report prototype backed by immutable S3 objects. Publication is
// visible ONLY after the final commit manifest is written successfully.
// Caller must resolve family links and clinical admission ownership BEFORE
// calling publish. This module never guesses a parent/child relationship.
const {KEY_PART}=require('./object-store.cjs');
const KINDS=new Set(['morning','evening','psychology']);
const MS_DAY=86400000;
function id(value,name){
  if(typeof value!=='string'||!KEY_PART.test(value))
    throw new Error('S3_REPORT_INVALID_'+name);
  return value;
}
function day(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||
     Number.isNaN(Date.parse(value+'T00:00:00.000Z'))||
     new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)!==value)
    throw new Error('S3_REPORT_INVALID_DATE');
  return value;
}
function kind(value){
  if(!KINDS.has(value))throw new Error('S3_REPORT_INVALID_KIND');
  return value;
}
function revision(value){
  if(!Number.isSafeInteger(value)||value<1)throw new Error('S3_REPORT_INVALID_REVISION');
  return value;
}
function itemPath(pubId,familyId,k){
  return 'reports/items/'+pubId+'/'+familyId+'-'+k+'.json';
}
function manifestPath(k,date,rev,pubId){
  return 'reports/commits/'+k+'/'+date+'/'+String(rev).padStart(16,'0')+
    '-'+pubId+'.json';
}
function sameCore(a,b){
  return a&&a.v===b.v&&a.kind===b.kind&&a.date===b.date&&
    a.revision===b.revision&&a.publicationId===b.publicationId&&
    a.sourceFingerprint===b.sourceFingerprint&&
    JSON.stringify(a.families)===JSON.stringify(b.families);
}
function createS3ReportStore({objects,now=()=>Date.now(),days=7,maxCommits=1000}={}){
  if(!objects?.putOnce||!objects?.getJson||!objects?.listJsonKeys||
     !Number.isInteger(days)||days<1||days>45||
     !Number.isInteger(maxCommits)||maxCommits<1)
    throw new Error('S3_REPORT_INVALID_STORE');
  async function publish({kind:reportKind,date,revision:rev,publicationId,
    sourceFingerprint='',reports}){
    kind(reportKind);day(date);revision(rev);id(publicationId,'PUBLICATION');
    if(typeof sourceFingerprint!=='string'||sourceFingerprint.length>128||
       !Array.isArray(reports)||reports.length<1||reports.length>500)
      throw new Error('S3_REPORT_INVALID_PUBLICATION');
    const seen=new Set();
    const items=reports.map(item=>{
      const familyId=id(item?.familyId,'FAMILY');
      if(seen.has(familyId))throw new Error('S3_REPORT_DUPLICATE_FAMILY');
      seen.add(familyId);
      if(typeof item.text!=='string'||!item.text.trim()||item.text.length>30000)
        throw new Error('S3_REPORT_INVALID_TEXT');
      return {v:1,kind:reportKind,date,revision:rev,publicationId,
        familyId,text:item.text};
    }).sort((a,b)=>a.familyId.localeCompare(b.familyId));
    const families=items.map(x=>x.familyId);
    const manifest={v:1,kind:reportKind,date,revision:rev,publicationId,
      sourceFingerprint,families,committedAt:Number(now())};
    const mpath=manifestPath(reportKind,date,rev,publicationId);
    const old=await objects.getJson(mpath);
    if(old){
      if(!sameCore(old,manifest))throw new Error('S3_REPORT_PUBLICATION_CONFLICT');
      return {committed:true,reused:true,publicationId,recipients:families.length};
    }
    // Each object is immutable and safely retryable. Orphaned objects from a
    // failed write remain invisible to readers until this manifest is saved.
    for(const item of items)
      await objects.putOnce(itemPath(publicationId,item.familyId,reportKind),item);
    try{
      await objects.putOnce(mpath,manifest);
    }catch(error){
      if(error?.message!=='S3_HYBRID_IMMUTABLE_CONFLICT')throw error;
      const winner=await objects.getJson(mpath);
      if(!sameCore(winner,manifest))throw new Error('S3_REPORT_PUBLICATION_CONFLICT');
    }
    return {committed:true,reused:false,publicationId,recipients:families.length};
  }
  async function listFamily({familyId,at=now()}){
    id(familyId,'FAMILY');
    const time=Number(at);
    if(!Number.isFinite(time))throw new Error('S3_REPORT_INVALID_TIME');
    // Read-time retention is independent of eventual physical S3 deletion.
    const minDate=new Date(time-(days-1)*MS_DAY).toISOString().slice(0,10);
    const maxDate=new Date(time).toISOString().slice(0,10);
    const keys=(await Promise.all(Array.from(KINDS,k=>
      objects.listJsonKeys('reports/commits/'+k+'/',{limit:maxCommits})
    ))).flat();
    const dated=keys.filter(key=>{
      const parts=key.split('/');
      return parts.length===5&&parts[0]==='reports'&&parts[1]==='commits'&&
        KINDS.has(parts[2])&&parts[3]>=minDate&&parts[3]<=maxDate;
    });
    const manifests=(await Promise.all(dated.map(x=>objects.getJson(x))))
      .filter(x=>x&&KINDS.has(x.kind)&&x.date>=minDate&&x.date<=maxDate&&
        Number.isSafeInteger(x.revision));
    const byDate=new Map();
    for(const m of manifests){
      const k=m.kind+':'+m.date,old=byDate.get(k);
      if(old&&m.revision===old.revision&&m.publicationId!==old.publicationId)
        throw new Error('S3_REPORT_REVISION_CONFLICT');
      if(!old||m.revision>old.revision)byDate.set(k,m);
    }
    const selected=[...byDate.values()].filter(m=>m.families?.includes(familyId));
    const entries=await Promise.all(selected.map(async m=>{
      const item=await objects.getJson(itemPath(m.publicationId,familyId,m.kind));
      if(!item||item.publicationId!==m.publicationId||
          item.familyId!==familyId||item.revision!==m.revision||
          item.kind!==m.kind||item.date!==m.date)
        throw new Error('S3_REPORT_COMMITTED_OBJECT_MISSING');
      return {kind:m.kind,date:m.date,revision:m.revision,text:item.text,
        publicationId:m.publicationId};
    }));
    return entries.sort((a,b)=>b.date.localeCompare(a.date)||
      ['morning','psychology','evening'].indexOf(a.kind)-
      ['morning','psychology','evening'].indexOf(b.kind));
  }
  return {publish,listFamily};
}
module.exports={createS3ReportStore};
