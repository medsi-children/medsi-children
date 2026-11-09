import {purgeUnreferencedChild} from './parent-deletion.mjs';
import {reconcileUnlinkedRegisteredParents} from './parent-admission-matching.mjs';
import {backfillRecentEducatorReports} from './source-report-backfill.mjs';

export function createOrphanChildCleanup(sql,{now=()=>Date.now(),enabled=false}={}){
  async function run({execute=false}={}){
    if(execute&&!enabled)throw new Error('Parent deletion temporarily disabled until migration audit.');
    const result=await sql.begin({isolation:execute?'serializableReadWrite':'snapshotReadOnly',idempotent:true},async tx=>{
      const [[children],[admissions],[profiles]]=await Promise.all([
        tx`SELECT child_id FROM children`,
        tx`SELECT admission_id,child_id FROM admissions`,
        tx`SELECT child_id,admission_id FROM parent_profiles`
      ]);
      const protectedChildren=new Set(profiles.map(p=>String(p.child_id||'')).filter(Boolean));
      const referencedStays=new Set(profiles.map(p=>String(p.admission_id||'')).filter(Boolean));
      for(const stay of admissions)if(referencedStays.has(String(stay.admission_id)))protectedChildren.add(String(stay.child_id));
      const identities=new Set([...children.map(c=>String(c.child_id)),...admissions.map(a=>String(a.child_id))].filter(Boolean));
      const candidates=[...identities].filter(id=>!protectedChildren.has(id)).map(child_id=>({child_id}));
      let removed=0;
      if(execute)for(const child of candidates){
        // Historic orphan records must not fence the current source reports
        // for newly registered, genuinely unlinked parents. Existing report
        // ownership is still anonymized and quarantined by the purge helper.
        if(await purgeUnreferencedChild(tx,child.child_id,now(),{guardOldSources:false}))removed++;
      }
      return {ok:true,candidates:candidates.length,removed,executed:execute};
    });
    if(execute){
      await reconcileUnlinkedRegisteredParents(sql,{now});
      await backfillRecentEducatorReports(sql,{now});
    }
    return result;
  }
  return {preview:()=>run(),execute:()=>run({execute:true})};
}
