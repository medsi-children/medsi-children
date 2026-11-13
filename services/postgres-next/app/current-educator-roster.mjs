import {createCurrentChildLinkStore} from './current-child-link-store.mjs';
import {createCurrentReportBackfill} from './current-report-backfill.mjs';
const PHONE=/^\d{10}$/;
const ID=/^[A-Za-z0-9_-]{8,128}$/;
const name=x=>String(x||'').trim().normalize('NFC').replace(/\s+/g,' ');
const valid=(x,max=100)=>{const s=name(x);if(!s||s.length>max||/[<>\x00-\x1f]/.test(s))throw Error('Invalid name.');return s};
const validId=x=>{const s=String(x||'');if(!ID.test(s))throw Error('Invalid child ID.');return s};

// Only children with REGISTERED profiles appear in the registered-parent
// directory. The staff source itself keeps the unregistered children.
export function assembleCurrentEducatorRoster({children=[],profiles=[],current=[],
  authenticated=[],heads=[]}={}){
  const childById=new Map(children.map(c=>[String(c.child_id),c]));
  const registered=new Set(authenticated.map(x=>String(x.phone10)));
  const linked=new Map(),unlinked=[],review=[];
  for(const p of profiles){
    const phone10=String(p.phone10||'');
    if(!PHONE.test(phone10))continue;
    const childId=String(p.child_id||'');
    const parent={phone10,phone:'8'+phone10,parentName:String(p.parent_name||''),
      relationship:String(p.relationship||'Родитель'),childName:String(p.child_name||''),
      registered:registered.has(phone10)};
    if(!childId){if(parent.registered)unlinked.push({...parent,linked:false});continue}
    const child=childById.get(childId);
    if(!child){review.push({...parent,linked:false,reason:'missing-child'});continue}
    if(!linked.has(childId))linked.set(childId,{childId,
      firstName:String(child.registered_first_name||''),surname:String(child.surname||''),
      parents:[],morning:false,evening:false});
    linked.get(childId).parents.push(parent);
  }
  const headMap=new Map(heads.map(x=>[x.kind,x.publication_id]));
  for(const r of current){
    const card=linked.get(String(r.child_id||''));
    if(!card||!card.parents.some(p=>p.phone10===r.phone10)||
      !String(r.text||'').trim()||r.text==='Пока ещё нет отчёта 🙏'||
      r.publication_id!==headMap.get(r.kind))continue;
    if(r.kind==='morning')card.morning=true;
    if(r.kind==='evening')card.evening=true;
  }
  const cards=[...linked.values()].map(c=>({...c,
    parents:c.parents.sort((a,b)=>a.parentName.localeCompare(b.parentName,'ru'))}))
    .sort((a,b)=>(a.surname+a.firstName).localeCompare(b.surname+b.firstName,'ru'));
  return {ok:true,children:cards,
    unlinked:unlinked.sort((a,b)=>a.phone.localeCompare(b.phone)),
    review:review.sort((a,b)=>a.phone.localeCompare(b.phone)),
    counts:{activeChildren:cards.length,
      activeParentProfiles:cards.reduce((n,c)=>n+c.parents.length,0),
      unlinkedProfiles:unlinked.length,reviewProfiles:review.length}};
}
export function createCurrentEducatorRosterStore(sql,{now=()=>Date.now()}={}){
  if(!sql?.begin)throw Error('PostgreSQL required.');
  const linking=createCurrentChildLinkStore(sql,{now});
  const backfill=createCurrentReportBackfill(sql,{now});
  async function list(){
    try{await linking.reconcile()}catch(_){}
    try{await backfill.recover()}catch(_){}
    return sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>{
      const [[children],[profiles],[current],[auth],[heads]]=await Promise.all([
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT phone10,parent_name,relationship,child_name,child_id FROM parent_profiles`,
        tx`SELECT phone10,child_id,publication_id,kind,text FROM parent_current_reports`,
        tx`SELECT phone10 FROM parent_auth_profiles`,
        tx`SELECT kind,publication_id FROM report_publication_head`
      ]);
      return assembleCurrentEducatorRoster({children,profiles,current,authenticated:auth,heads});
    });
  }
  async function update(payload={}){
    const kind=String(payload.kind||'');
    if(kind==='child'){
      const childId=validId(payload.childId);
      const firstName=valid(payload.firstName,70),surname=valid(payload.surname,100);
      return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
        const [[child]]=await tx`SELECT registered_first_name,surname FROM children
          WHERE child_id=${childId} FOR UPDATE`;
        const [parents]=await tx`SELECT phone10 FROM parent_profiles WHERE child_id=${childId}`;
        if(!child||!parents.length||name(child.registered_first_name)!==name(payload.expectedFirstName)||
          name(child.surname)!==name(payload.expectedSurname))throw new Error('Roster changed; reload.');
        await tx`UPDATE children SET registered_first_name=${firstName},surname=${surname}
          WHERE child_id=${childId}`;
        await tx`UPDATE parent_profiles SET child_name=${firstName+' '+surname},
          updated_at=${BigInt(now())} WHERE child_id=${childId}`;
        return {ok:true,childId};
      });
    }
    if(kind==='parent'){
      const phone10=String(payload.phone10||'');
      if(!PHONE.test(phone10))throw Error('Invalid phone.');
      const childId=validId(payload.childId),parentName=valid(payload.parentName,130);
      const relationship=valid(payload.relationship,50);
      return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
        const [[p]]=await tx`SELECT parent_name,relationship,child_id
          FROM parent_profiles WHERE phone10=${phone10} FOR UPDATE`;
        if(!p||String(p.child_id)!==childId||
          name(p.parent_name)!==name(payload.expectedParentName)||
          name(p.relationship||'Родитель')!==name(payload.expectedRelationship||'Родитель'))
          throw new Error('Roster changed; reload.');
        await tx`UPDATE parent_profiles SET parent_name=${parentName},
          relationship=${relationship},updated_at=${BigInt(now())}
          WHERE phone10=${phone10}`;
        return {ok:true,phone10};
      });
    }
    throw new Error('Invalid roster update.');
  }
  return {list,update};
}
