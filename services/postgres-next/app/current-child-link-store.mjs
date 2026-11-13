import {randomUUID} from 'node:crypto';
import {matchCurrentSource} from './current-child-identity.mjs';
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
      const today=moscowDate(now()),cutoff=moscowDate(now()-7*86400000);
      const [[profiles],[auth],[children],[variants],[publications],[owners]]=await Promise.all([
        phone10?tx`SELECT phone10,child_name,child_id,profile_generation FROM parent_profiles
          WHERE phone10=${phone10}`:
          tx`SELECT phone10,child_name,child_id,profile_generation FROM parent_profiles`,
        phone10?tx`SELECT phone10 FROM parent_auth_profiles WHERE phone10=${phone10}`:
          tx`SELECT phone10 FROM parent_auth_profiles`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`,
        tx`SELECT publication_id,kind,report_date,normalized_text,submitted_at,revision
          FROM raw_reports WHERE kind IN (${'morning'},${'evening'})
            AND report_date>=${cutoff} AND report_date<=${today}
          ORDER BY submitted_at DESC LIMIT 60`,
        tx`SELECT owner_key,record_json FROM report_ownership WHERE owner_key LIKE ${'CURRENT\\_BLOCK\\_%'}`
      ]);
      const ownersByPublication=new Map();
      for(const row of owners){const m=/^CURRENT_BLOCK_(.+)_(\d+)$/.exec(String(row.owner_key||''));if(!m)continue;
        let record;try{record=JSON.parse(String(row.record_json||''))}catch{record={blocked:true};}
        if(!ownersByPublication.has(m[1]))ownersByPublication.set(m[1],[]);
        ownersByPublication.get(m[1])[Number(m[2])]=record;
      }
      for(const publication of publications)publication.blockOwners=ownersByPublication.get(String(publication.publication_id))||[];
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
        const decision=matchCurrentSource({
          childName:parent.child_name,profiles:allProfiles,children,
          nameVariants:variants,publications,today:moscowDate(now())
        });
        let matched=decision.status==='linked'?{childId:decision.childId}:null;
        if(decision.status==='new'){
          const childId='child_'+randomUUID().replace(/-/g,'');
          await tx.upsert`INSERT INTO children
            (child_id,registered_first_name,surname,created_at)
            VALUES (${childId},${decision.firstName},${decision.surname},${BigInt(now())})`;
          matched={childId};
          if(decision.publicationId&&Number.isSafeInteger(decision.blockIndex)){
            const ownerKey=`CURRENT_BLOCK_${decision.publicationId}_${decision.blockIndex}`;
            const [ownerRows]=await tx`SELECT record_json FROM report_ownership WHERE owner_key=${ownerKey} FOR UPDATE`;
            const value=JSON.stringify({childId,pending:false,blocked:false});
            if(ownerRows.length){let prior;try{prior=JSON.parse(String(ownerRows[0].record_json||''))}catch{prior={blocked:true}}
              if(prior.blocked||prior.childId&&String(prior.childId)!==childId)
                throw new Error('Report ownership changed during registration.');
              const [changed]=await tx`UPDATE report_ownership SET record_json=${value},updated_at=${BigInt(now())}
                WHERE owner_key=${ownerKey} AND record_json=${ownerRows[0].record_json} RETURNING owner_key`;
              if(changed.length!==1)throw new Error('Report ownership changed during registration.');
            }else{
              const [inserted]=await tx`INSERT INTO report_ownership (owner_key,record_json,updated_at)
                VALUES (${ownerKey},${value},${BigInt(now())}) ON CONFLICT (owner_key) DO NOTHING RETURNING owner_key`;
              if(inserted.length!==1)throw new Error('Report ownership changed during registration.');
            }
          }
          if(!children.some(row=>String(row.child_id)===childId))
            children.push({child_id:childId,registered_first_name:decision.firstName,
              surname:decision.surname});
        }
        if(!matched){
          decision.status==='ambiguous'?ambiguous++:pending++;
          continue;
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
