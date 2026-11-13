import {displayCurrentStaffSource} from './current-educator-source-display.mjs';
import {normalizeCurrentReportPunctuation} from './current-report-punctuation.mjs';
const PHONE=/^\d{10}$/;
const KINDS=['morning','evening','psychology'];
export function assembleCurrentEducatorDashboard({profiles=[],children=[],current=[],
  heads=[],rawByPublication=new Map(),ownerByPublication=new Map(),
  nameVariants=[]}={}){
  const childById=new Map(children.map(c=>[String(c.child_id),c]));
  const headByKind=new Map(heads.map(h=>[h.kind,h.publication_id]));
  const cards=new Map();
  for(const p of profiles){
    if(!PHONE.test(String(p.phone10||'')))continue;
    const childId=String(p.child_id||''),child=childById.get(childId);
    if(!child)continue;
    if(!cards.has(childId))cards.set(childId,{
      childId,
      childName:String(child.registered_first_name||''),
      surname:String(child.surname||''),parents:[],parentViews:[]
    });
    const card=cards.get(childId);
    const parent={parentName:String(p.parent_name||''),
      relationship:String(p.relationship||'Родитель'),phone:'8'+p.phone10};
    card.parents.push(parent);
    const reports={morning:'',evening:'',psychology:''};
    for(const r of current)if(r.phone10===p.phone10&&r.child_id===childId&&
      ['morning','evening'].includes(r.kind)&&r.publication_id===headByKind.get(r.kind))
      reports[r.kind]=normalizeCurrentReportPunctuation(r.text||'');
    const therapy=headByKind.get('psychology')&&rawByPublication.get(headByKind.get('psychology'));
    if(therapy)reports.psychology=normalizeCurrentReportPunctuation(therapy.normalized_text||'');
    card.parentViews.push({phone:parent.phone,phone10:p.phone10,
      childId,parentName:parent.parentName,reports});
  }
  const raw={};
  for(const kind of KINDS){
    const publicationId=headByKind.get(kind);
    const source=publicationId&&rawByPublication.get(publicationId);
    raw[kind]=source?{
      reportDate:String(source.report_date||''),
      normalizedText:normalizeCurrentReportPunctuation(source.normalized_text||''),
      rawText:String(source.raw_text||''),
      displayText:kind==='psychology'?normalizeCurrentReportPunctuation(source.raw_text||''):
        normalizeCurrentReportPunctuation(displayCurrentStaffSource({rawText:String(source.normalized_text||''),
          children,profiles,ownerRecords:ownerByPublication.get(publicationId)||[],
          nameVariants})),
      publicationId
    }:{reportDate:'',normalizedText:'',rawText:'',displayText:''};
  }
  const result=[...cards.values()].map(c=>({
    ...c,parents:c.parents.sort((a,b)=>a.phone.localeCompare(b.phone)),
    parentViews:c.parentViews.sort((a,b)=>a.phone.localeCompare(b.phone))
  })).sort((a,b)=>(a.surname+a.childName).localeCompare(b.surname+b.childName,'ru'));
  return {ok:true,raw,children:result};
}
export function createCurrentEducatorDashboardStore(sql){
  if(!sql?.begin)throw Error('PostgreSQL required.');
  async function readForEducator(){
    return sql.begin({isolation:'snapshotReadOnly',idempotent:true},async tx=>{
      const [[profiles],[children],[current],[heads],[variants]]=await Promise.all([
        tx`SELECT phone10,parent_name,relationship,child_id FROM parent_profiles`,
        tx`SELECT child_id,registered_first_name,surname FROM children`,
        tx`SELECT phone10,child_id,kind,text,publication_id FROM parent_current_reports`,
        tx`SELECT kind,publication_id FROM report_publication_head`,
        tx`SELECT base_key,preferred_name,variants_json FROM name_variants`
      ]);
      const rawByPublication=new Map(),ownerByPublication=new Map();
      for(const head of heads){
        if(!KINDS.includes(head.kind)||!head.publication_id)continue;
        const [[source]]=await tx`SELECT publication_id,kind,report_date,raw_text,normalized_text
          FROM raw_reports WHERE publication_id=${head.publication_id}`;
        if(source)rawByPublication.set(head.publication_id,source);
        if(['morning','evening'].includes(head.kind)){
          const [owners]=await tx`SELECT owner_key,record_json FROM report_ownership
            WHERE owner_key LIKE ${'CURRENT_BLOCK_'+head.publication_id+'_%'}`;
          ownerByPublication.set(head.publication_id,owners);
        }
      }
      return assembleCurrentEducatorDashboard({
        profiles,children,current,heads,rawByPublication,ownerByPublication,nameVariants:variants
      });
    });
  }
  return {readForEducator};
}
