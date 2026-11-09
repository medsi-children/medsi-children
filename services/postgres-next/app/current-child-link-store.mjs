import {randomUUID} from 'node:crypto';
import {matchRegisteredChild,matchCurrentSource} from './current-child-identity.mjs';
const PHONE=/^\d{10}$/;
const moscowDate=value=>{
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Moscow',
    year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
};
// A child row exists only for registered parents. Source-only children need
// no identity row. This store never reads or creates hospital admissions.
export function createCurrentChildLinkStore(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  async function reconcile({phone10=''}={}){
    if(phone10&&!PHONE.test(String(phone10)))throw new Error('Invalid parent phone.');
    return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
      const [[profiles],[auth],[children],[variants],[publications]]=await Promise.all([
        phone10?tx`SELECT phone10,child_name,child_id,profile_generation FROM parent_profiles
          WHERE phone10=${phone10}`:
          tx`SELECT phone10,child_name,child_id,profile_generation FROM parent_profiles`,
        phone10?tx`SELECT phone10 FROM parent_auth_profiles WHERE phone10=${phone10}`:
          tx`SELECT phone10 FROM parent_auth_profiles`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT r.publication_id,r.kind,r.report_date,r.normalized_text,r.submitted_at
          FROM report_publication_head AS h
          INNER JOIN raw_reports AS r ON h.publication_id=r.publication_id
          WHERE r.kind IN (${'morning'},${'evening'})`
      ]);
      const verified=new Set(auth.map(x=>String(x.phone10)));
      const waiting=profiles.filter(p=>verified.has(String(p.phone10))&&
        !String(p.child_id||'').trim()&&String(p.child_name||'').trim());
      if(!waiting.length)return {ok:true,linked:0,pending:0,ambiguous:0};
      // A phone-scoped repair also needs the other registered parents.
      const [allProfiles]=phone10
        ?await tx`SELECT phone10,child_name,child_id FROM parent_profiles`
        :[profiles];
      let linked=0,pending=0,ambiguous=0;
      for(const parent of waiting){
        let matched=matchRegisteredChild({childName:parent.child_name,
          profiles:allProfiles,children,nameVariants:variants});
        if(!matched){
          const decision=matchCurrentSource({
            childName:parent.child_name,profiles:allProfiles,children,
            nameVariants:variants,publications,today:moscowDate(now())
          });
          if(decision.status==='new'){
            const childId='child_'+randomUUID().replace(/-/g,'');
            await tx.upsert`INSERT INTO children
              (child_id,registered_first_name,surname,created_at)
              VALUES (${childId},${decision.firstName},${decision.surname},${BigInt(now())})`;
            matched={childId};
            children.push({child_id:childId,registered_first_name:decision.firstName,
              surname:decision.surname});
          }else{
            decision.status==='ambiguous'?ambiguous++:pending++;
            continue;
          }
        }
        const [updated]=await tx`UPDATE parent_profiles
          SET child_id=${matched.childId},updated_at=${BigInt(now())}
          WHERE phone10=${String(parent.phone10)} AND COALESCE(child_id,${''})=${''}
          RETURNING phone10`;
        if(!updated.length)continue;
        parent.child_id=matched.childId;
        const local=allProfiles.find(p=>p.phone10===parent.phone10);
        if(local)local.child_id=matched.childId;
        linked++;
        if(parent.profile_generation){
          await tx`UPDATE parent_registration_attempts
            SET child_id=${matched.childId},updated_at=${BigInt(now())}
            WHERE attempt_id=${String(parent.profile_generation)}
              AND phone10=${String(parent.phone10)}
              AND status=${'COMPLETED'}`;
        }
      }
      return {ok:true,linked,pending,ambiguous};
    });
  }
  return {reconcile};
}
