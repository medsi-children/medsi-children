import {createDoctorsDisk,validDiskRoot,directDiskChild,diskVersion,verifyDiskBytes,isPlan} from './doctors-disk.mjs';
import {readPlanDates,validIsoDate} from './doctors-xlsx.mjs';
import {doctorNameParts,createDoctorNameMatcher} from './doctors-names.mjs';
import {fullName} from './doctors-roster.mjs';
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
export function candidateFolder(name,parts,matcher){
  if(matcher.matches(name,parts))return true;
  if(parts&&parts.slice(0,2).some(word=>word.length>=4&&fullName(name)===word))return true;
  const words=doctorNameParts(name);
  if(!parts||!words||parts.length>3||words.length>3)return false;
  if(parts[2]&&words[2]&&parts[2]!==words[2])return false;
  return [[words[0],words[1]],[words[1],words[0]]].some(([a,b])=>
    (a===parts[0]&&oneEdit(b,parts[1]))||(b===parts[1]&&oneEdit(a,parts[0])));
}

// Never invent a discharge from a single admission date, and never pick
// the largest date merely because it is largest. Resolve duplicates by
// document class, then a distinguishable revision day or full filename date.
export function chooseReadOnlyPlan(plans){
  const dated=plans.filter(p=>validIsoDate(p.discharge)&&p.discharge>=p.admission);
  if(!dated.length)return {status:plans.length?'noDischarge':'noCurrentPlan',discharge:null};
  const priority=Math.max(...dated.map(p=>p.rank));
  let top=dated.filter(p=>p.rank===priority);
  const newest=top.map(p=>p.modifiedDay||'').sort().at(-1);
  if(newest&&top.every(p=>p.modifiedDay))top=top.filter(p=>p.modifiedDay===newest);
  if(top.length>1&&top.every(p=>p.nameDate)){
    const latest=top.map(p=>p.nameDate).sort().at(-1);
    top=top.filter(p=>p.nameDate===latest);
  }
  const dates=new Set(top.map(p=>p.discharge));
  if(dates.size!==1)return {status:'conflict',discharge:null};
  return {status:'verified',discharge:[...dates][0],kind:priority===3?'final':priority===2?'ordinary':'preliminary'};
}

export function candidateRootPlan(name,parts){
  const tokens=fullName(name).match(/\p{L}+(?:-\p{L}+)*/gu)||[];
  return Boolean(parts&&parts.slice(0,2).some(word=>word.length>=4&&tokens.includes(word)));
}
export function createDoctorsDiskRead({env,listPatients,nameVariants,disk,sql,storage,now=Date.now}){
  const root=env.DOCTORS_DISK_ROOT;
  const policy=sql?smartWritePolicy(env,storage):null;
  const source=validDiskRoot(root)&&(disk||(env.DOCTORS_DISK_TOKEN?
    createDoctorsDisk(env.DOCTORS_DISK_TOKEN,fetch,{writeRoot:policy?.root||null,allowRootPlans:Boolean(policy)}):null));
  const writer=sql?createDoctorsSmartWrite({sql,policy,storage,source,root}):null;
  const enabled=Boolean(source&&env.DOCTORS_GREENWOOD_SHEET_ID);
  const interval=Math.max(60000,Number(env.DOCTORS_DISK_INTERVAL_MS)||300000);
  let results=new Map(),cache=new Map(),running=false,stopped=false,timer,lastComplete=null,failed=false,issues={},counters={};
  const get=(id,episode)=>{
    const result=results.get(id);
    if(!result||result.episode!==episode)return null;
    if(failed||now()-result.checkedAt>interval*3)return {status:'stale',discharge:null};
    return result;
  };
  async function cycle(){
    if(!enabled||stopped||running)return;
    running=true;
    const next=new Map(),nextCache=new Map(),counts={},stats={patients:0,matched:0,withDischarge:0};
    try{
      const patients=await listPatients({fresh:true});
      const variants=await nameVariants?.list()||{items:[],revision:''};
      const matcher=createDoctorNameMatcher(variants.items);
      const identities=patients.map(p=>({p,parts:doctorNameParts(p.childName)}));
      const fingerprint=rows=>JSON.stringify(rows.map(p=>[p.id,p.childName,p.episode]).sort((a,b)=>a[0].localeCompare(b[0])));
      const rootItems=await source.list(root);
      const folders=rootItems.filter(x=>x.type==='dir'&&directDiskChild(root,x)&&
        x.path!=='disk:/medsi-doctors-test'&&!excluded(x.name));
      const rootPlans=rootItems.filter(x=>isPlan(x)&&directDiskChild(root,x)&&!/образец|шаблон/iu.test(x.name));
      stats.patients=patients.length;
      const folderCache=new Map();
      for(const {p,parts} of identities){
        if(stopped)return;
        let result={status:'noCurrentPlan',discharge:null};
        const candidates=parts&&p.episode?folders.filter(f=>candidateFolder(f.name,parts,matcher)):[];
        const rootCandidates=rootPlans.filter(f=>candidateRootPlan(f.name,parts));
        if(!parts||!p.episode)result.status=!parts?'nameUnrecognized':'missingAdmission';
        else if(!candidates.length&&!rootCandidates.length)result.status='noFolder';
        else if(candidates.length>12)result.status='ambiguousFolder';
        else{
          stats.matched++;
          const plans=[];
          let incomplete=false,unverified=0;
          const owns=name=>{
            const owners=identities.filter(x=>x.p.episode===p.episode&&matcher.matches(name,x.parts));
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
              if(d.admission!==p.episode){increment(counts,'otherEpisode');continue;}
              const owners=identities.filter(x=>x.p.episode===d.admission&&matcher.matches(d.patient,x.parts));
              if(owners.length!==1||owners[0].p.id!==p.id){
                increment(counts,owners.length>1?'ambiguousIdentity':'patientMismatch');unverified++;continue;
              }
              const modifiedDay=String(file.modified||'').slice(0,10);
              plans.push({...d,path:file.path,version,rank:rank(file.name),modifiedDay:validIsoDate(modifiedDay)?modifiedDay:null,nameDate:fileDate(file.name)});
            }
          }
          result=incomplete?{status:'incomplete',discharge:null}:chooseReadOnlyPlan(plans);
          if(!result.discharge&&unverified&&!incomplete)result.status='unverified';
          result={...result,targets:plans.map(({path,version,discharge})=>({path,version,discharge})).sort((a,b)=>a.path.localeCompare(b.path)),
            writeReady:!incomplete,unverified};
          if(writer?.enabled){
            try{
              const stillCurrent=async()=>{
                if(stopped)return false;
                const fresh=await listPatients({fresh:true});
                const freshVariants=await nameVariants?.list()||{revision:''};
                return fingerprint(fresh)===fingerprint(patients)&&freshVariants.revision===variants.revision;
              };
              await writer.run(p,result,owns,stillCurrent);
            }catch{increment(counts,'writeFailed');}
          }
        }
        increment(counts,result.status);
        if(result.discharge)stats.withDischarge++;
        next.set(p.id,{...result,episode:p.episode,checkedAt:now()});
      }
      try{await writer?.cleanup();}catch{increment(counts,'cleanupFailed');}
      results=next;cache=nextCache;issues=counts;counters=stats;lastComplete=new Date(now()).toISOString();failed=false;
    }catch{failed=true;issues={cycleFailed:1};}
    finally{running=false;if(!stopped){timer=setTimeout(cycle,interval);timer.unref?.();}}
  }
  return {get,writer,start:cycle,stop(){stopped=true;clearTimeout(timer);},diagnostics:()=>({enabled,writeEnabled:Boolean(writer?.enabled),running,lastComplete,failed,counters,issues})};
}
