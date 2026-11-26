import {createDoctorsDisk,validDiskRoot,directDiskChild,diskVersion,verifyDiskBytes,isPlan} from './doctors-disk.mjs';
import {readPlanDates,validIsoDate} from './doctors-xlsx.mjs';
import {doctorNameOptions,createDoctorNameMatcher} from './doctors-names.mjs';
import {fullName} from './doctors-roster.mjs';
import {createDoctorsDiskSnapshot,doctorRosterKey} from './doctors-disk-snapshot.mjs';
import {smartWritePolicy,createDoctorsSmartWrite} from './doctors-smart-write.mjs';

const increment=(counts,key)=>{counts[key]=(counts[key]||0)+1;};
const rank=name=>/итог/iu.test(name)?3:/предв/iu.test(name)?1:2;
const excluded=name=>/^(?:план обследования и лечения образец|истории болезни|check up|scan|промты|больничные|лн)$/iu.test(name.trim());
const fileDate=name=>{
  const matches=[...name.matchAll(/(?:^|[^\d])(\d{1,2})[.](\d{1,2})[.](\d{4})(?!\d)/gu)]
    .map(m=>[m[3],m[2].padStart(2,'0'),m[1].padStart(2,'0')].join('-')).filter(validIsoDate);
  return matches.length===1?matches[0]:null;
};
// A one-letter folder typo is a search hint ONLY. A date is accepted only
// after the internal patient name and admission independently verify it.
function oneEdit(a,b){
  if(a===b||Math.min(a.length,b.length)<5||Math.abs(a.length-b.length)>1)return false;
  if(a.length>b.length)[a,b]=[b,a];
  let i=0,j=0,edits=0;
  while(i<a.length&&j<b.length){
    if(a[i]===b[j]){i++;j++;continue;}
    if(++edits>1)return false;
    if(a.length===b.length)i++;
    j++;
  }
  return edits+(b.length-j)===1;
}
export function candidateFolder(name,options,matcher){
  if(matcher.matchesOptions(name,options))return true;
  if(options.some(parts=>parts.slice(0,2).some(word=>word.length>=4&&fullName(name)===word)))return true;
  const source=doctorNameOptions(name);
  return source.some(words=>options.some(parts=>{
    if(parts.length>3||words.length>3||parts[2]&&words[2]&&parts[2]!==words[2])return false;
    return [[words[0],words[1]],[words[1],words[0]]].some(([a,b])=>
      (a===parts[0]&&oneEdit(b,parts[1]))||(b===parts[1]&&oneEdit(a,parts[0])));
  }));
}

// Never invent a discharge from a single admission date, and never pick
// the largest date merely because it is largest. Resolve duplicates by
// document class, then the full Disk timestamp or the date in the filename.
export function chooseReadOnlyPlan(plans){
  const dated=plans.filter(p=>validIsoDate(p.discharge)&&p.discharge>=p.admission);
  if(!dated.length)return {status:plans.length?'noDischarge':'noCurrentPlan',discharge:null};
  const priority=Math.max(...dated.map(p=>p.rank));
  let top=dated.filter(p=>p.rank===priority);
  // Compare creation times only when every candidate exposes one.
  for(const field of ['created','modified']){
    const times=top.map(p=>Date.parse(p[field]));
    if(times.every(Number.isFinite)){
      const newest=Math.max(...times);
      top=top.filter((_,index)=>times[index]===newest);
    }
  }
  if(top.length>1&&top.every(p=>p.nameDate)){
    const latest=top.map(p=>p.nameDate).sort().at(-1);
    top=top.filter(p=>p.nameDate===latest);
  }
  const dates=new Set(top.map(p=>p.discharge));
  if(dates.size!==1)return {status:'conflict',discharge:null};
  return {status:'verified',discharge:[...dates][0],kind:priority===3?'final':priority===2?'ordinary':'preliminary'};
}

// A discrepancy is evidence for review, not a verified hospitalization.
// Require a literal name pair, unique among the active registry, plus a
// one-calendar-day difference and an explicit discharge.
export function nearAdmission(plan,patient,options,identities,matcher){
  if(!validIsoDate(plan.admission)||!validIsoDate(patient.episode)||!validIsoDate(plan.discharge)||
    plan.discharge<patient.episode||Math.abs(Date.parse(plan.admission)-Date.parse(patient.episode))!==86400000)return false;
  if(!matcher.matchesOptions(plan.patient,options,{literal:true}))return false;
  const owners=identities.filter(x=>matcher.matchesOptions(plan.patient,x.options));
  return owners.length===1&&owners[0].p.id===patient.id;
}
export function candidateRootPlan(name,options){
  const tokens=fullName(name).match(/\p{L}+(?:-\p{L}+)*/gu)||[];
  return options.some(parts=>parts.slice(0,2).some(word=>word.length>=4&&tokens.includes(word)));
}
export function createDoctorsDiskRead({env,listPatients,nameVariants,disk,sql,storage,now=Date.now}){
  const root=env.DOCTORS_DISK_ROOT;
  const policy=sql?smartWritePolicy(env,storage):null;
  const source=validDiskRoot(root)&&(disk||(env.DOCTORS_DISK_TOKEN?
    createDoctorsDisk(env.DOCTORS_DISK_TOKEN,fetch,{writeRoot:policy?.root||null,allowRootPlans:Boolean(policy)}):null));
  const writer=sql?createDoctorsSmartWrite({sql,policy,storage,source,root}):null;
  const enabled=Boolean(source&&env.DOCTORS_GREENWOOD_SHEET_ID);
  const interval=Math.max(60000,Number(env.DOCTORS_DISK_INTERVAL_MS)||300000);
  const snapshot=enabled?createDoctorsDiskSnapshot({sql,env,now}):null;
  let results=new Map(),cache=new Map(),running=false,stopped=false,timer,lastComplete=null,currentRosterKey=null,failed=false,issues={},counters={};
  const get=(id,episode,rosterKey)=>{
    if(rosterKey!==undefined&&rosterKey!==currentRosterKey)return null;
    const result=results.get(id);
    if(!result||result.episode!==episode)return null;
    if(failed||now()-result.checkedAt>interval*3)return null;
    return result;
  };
  async function cycle(){
    if(!enabled||stopped||running)return;
    running=true;
    const scanStarted=now();
    const next=new Map(),nextCache=new Map(),counts={},stats={patients:0,matched:0,withDischarge:0};
    try{
      const patients=await listPatients({fresh:true});
      const rosterKey=doctorRosterKey(patients);
      const previous=await snapshot.read(rosterKey);
      const display=Object.create(null);
      const variants=await nameVariants?.list()||{items:[],revision:''};
      const matcher=createDoctorNameMatcher(variants.items);
      const identities=patients.map(p=>({p,options:doctorNameOptions(p.childName)}));
      const rootItems=await source.list(root);
      const folders=rootItems.filter(x=>x.type==='dir'&&directDiskChild(root,x)&&
        x.path!=='disk:/medsi-doctors-test'&&!excluded(x.name));
      const rootPlans=rootItems.filter(x=>isPlan(x)&&directDiskChild(root,x)&&!/образец|шаблон/iu.test(x.name));
      stats.patients=patients.length;
      stats.withCandidateDischarge=0;
      const folderCache=new Map();
      for(const {p,options} of identities){
        if(stopped)return;
        let result={status:'noCurrentPlan',discharge:null};
        let incomplete=false;
        const candidates=options.length&&p.episode?folders.filter(f=>candidateFolder(f.name,options,matcher)):[];
        const rootCandidates=rootPlans.filter(f=>candidateRootPlan(f.name,options));
        if(!options.length||!p.episode)result.status=!options.length?'nameUnrecognized':'missingAdmission';
        else if(!candidates.length&&!rootCandidates.length)result.status='noFolder';
        else if(candidates.length>12)result.status='ambiguousFolder';
        else{
          stats.matched++;
          const plans=[],near=[];
          let unverified=0;
          const owns=name=>{
            const owners=identities.filter(x=>x.p.episode===p.episode&&matcher.matchesOptions(name,x.options));
            return owners.length===1&&owners[0].p.id===p.id;
          };
          for(const folder of [...candidates,...(rootCandidates.length?[{path:root,root:true}]:[])]){
            let items;
            try{
              if(folder.root)items=rootCandidates;
              else{
                if(!folderCache.has(folder.path))folderCache.set(folder.path,await source.list(folder.path));
                items=folderCache.get(folder.path).filter(x=>isPlan(x)&&directDiskChild(folder.path,x)&&!/образец|шаблон/iu.test(x.name));
              }
            }catch{increment(counts,'folderRead');incomplete=true;continue;}
            if(items.length>100){increment(counts,'folderLimit');incomplete=true;continue;}
            for(const file of items){
              if(stopped)return;
              const version=diskVersion(file);
              if(!version){increment(counts,'missingHash');incomplete=true;continue;}
              let parsed=nextCache.get(file.path)||cache.get(file.path);
              if(parsed?.version!==version){
                try{
                  const bytes=await source.download(file.path);
                  if(diskVersion(await source.stat(file.path))!==version||!verifyDiskBytes(bytes,version))throw Error('hash');
                  try{parsed={version,dates:readPlanDates(bytes)};}
                  catch{parsed={version,invalid:true};}
                }catch{increment(counts,'fileRead');incomplete=true;continue;}
              }
              nextCache.set(file.path,parsed);
              if(parsed.invalid){increment(counts,'invalidPlan');unverified++;continue;}
              const d=parsed.dates;
              const plan={...d,path:file.path,version,rank:rank(file.name),created:file.created,
                modified:file.modified,nameDate:fileDate(file.name)};
              if(d.admission!==p.episode){
                if(nearAdmission(d,p,options,identities,matcher)){
                  near.push(plan);increment(counts,'admissionOffOneDay');
                }else increment(counts,'otherEpisode');
                continue;
              }
              const owners=identities.filter(x=>x.p.episode===d.admission&&matcher.matchesOptions(d.patient,x.options));
              if(owners.length!==1||owners[0].p.id!==p.id){
                increment(counts,owners.length>1?'ambiguousIdentity':'patientMismatch');unverified++;continue;
              }
              plans.push(plan);
            }
          }
          result=chooseReadOnlyPlan(plans);
          if(incomplete)result={status:'incomplete',discharge:null};
          // Never override a verified exact-stay date or an exact-stay conflict.
          // Near-stay dates are usable for display only.
          if(!result.discharge&&!incomplete&&result.status!=='conflict'&&near.length){
            const selected=chooseReadOnlyPlan(near);
            result=selected.discharge?{status:'admissionMismatch',discharge:null,candidateDischarge:selected.discharge,kind:selected.kind}:selected;
          }
          if(!result.discharge&&!result.candidateDischarge&&unverified&&!incomplete&&result.status!=='conflict')result.status='unverified';
          result={...result,targets:plans.map(({path,version,discharge})=>({path,version,discharge})).sort((a,b)=>a.path.localeCompare(b.path)),
            writeReady:!incomplete&&!near.length,unverified};
          if(writer?.enabled){
            try{
              const stillCurrent=async()=>{
                if(stopped)return false;
                const fresh=await listPatients({fresh:true});
                const freshVariants=await nameVariants?.list()||{revision:''};
                return doctorRosterKey(fresh)===rosterKey&&freshVariants.revision===variants.revision;
              };
              await writer.run(p,result,owns,stillCurrent);
            }catch{increment(counts,'writeFailed');}
          }
        }
        increment(counts,result.status);
        if(result.discharge)stats.withDischarge++;
        if(result.candidateDischarge)stats.withCandidateDischarge++;
        const checkedAt=now();
        next.set(p.id,{...result,episode:p.episode,checkedAt});
        if(incomplete){
          if(Object.hasOwn(previous,p.id))display[p.id]=previous[p.id];
        }else if(result.discharge||result.candidateDischarge){
          const {status,discharge,candidateDischarge,kind}=result;
          display[p.id]={status,discharge,candidateDischarge,kind,checkedAt};
        }
      }
      try{await writer?.cleanup();}catch{increment(counts,'cleanupFailed');}
      try{await snapshot.publish(rosterKey,scanStarted,display);}catch{increment(counts,'snapshotFailed');}
      results=next;currentRosterKey=rosterKey;cache=nextCache;issues=counts;counters=stats;lastComplete=new Date(now()).toISOString();failed=false;
    }catch{failed=true;issues={cycleFailed:1};}
    finally{running=false;if(!stopped){timer=setTimeout(cycle,interval);timer.unref?.();}}
  }
  return {get,readDisplay:patients=>snapshot?.forRoster(patients),writer,start:cycle,stop(){stopped=true;clearTimeout(timer);},diagnostics:()=>({enabled,writeEnabled:Boolean(writer?.enabled),running,lastComplete,failed,counters,issues})};
}
