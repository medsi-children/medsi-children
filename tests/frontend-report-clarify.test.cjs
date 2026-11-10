const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../tutors/report-clarify.js'),'utf8');
function fakeModal(preview){
  const dialogs=[];
  const node=(tag)=>({
    tag,children:[],className:'',textContent:'',type:'',
    append(...items){this.children.push(...items)},
    close(){this.closed=true},remove(){this.removed=true},
    showModal(){dialogs.push(this)},addEventListener(){},
  });
  const document={createElement:node,body:{append(){}}};
  const transport={parentDelete:async(_session,payload)=>({
    accepted:true,ok:true,phone:payload.phone
  })};
  const window={MedsiEducatorSession:{get:async()=>({token:'educator_signed'})},
    MedsiOverlayTransport:transport};
  const ctx={window,document,
    fetch:async(_path,opts)=>{
      assert.match(_path,/report-clarify/);
      assert.equal(opts.headers['X-Medsi-Chat-Session'],'educator_signed');
      return {ok:true,json:async()=>preview};
    },crypto:{randomUUID:()=> 'abcdef00-0000-0000-0000-111111111111'}};
  vm.createContext(ctx);
  vm.runInContext(source,ctx);
  const buttons=dialog=>{
    const all=[];const walk=n=>{if(n.tag==='button')all.push(n);for(const c of n.children||[])walk(c)};
    walk(dialog);return all;
  };
  const choose=async label=>{
    for(let i=0;i<12&&!dialogs.length;i++)await Promise.resolve();
    const dialog=dialogs.at(-1);
    assert.ok(dialog,'dialog must appear');
    const button=buttons(dialog).find(x=>x.textContent===label);
    assert.ok(button,'missing '+label+' from '+buttons(dialog).map(x=>x.textContent).join(', '));
    button.onclick();
    for(let i=0;i<12;i++)await Promise.resolve();
    return dialog;
  };
  return {window,dialogs,buttons,choose};
}
const preview={ok:true,token:'server-fingerprint',conflicts:[{
  index:0,name:'Арина',excerpt:'Арина: занималась творчеством.',
  candidates:[
    {childId:'child_khalit',name:'Арина Халитова',phones:['9000000001','9000000002']},
    {childId:'child_amina',name:'Арина Амелина',phones:['9000000003']}
  ]
}]};
test('educator selects Арина Халитова then keeps discharged candidate in bot',async()=>{
  const h=fakeModal(preview);
  const promise=h.window.MedsiReportClarifier.prepare({kind:'evening',text:'Арина — Рисовала.'});
  await h.choose('Арина Халитова');
  await h.choose('Нет, оставить');
  const choice=await promise;
  assert.deepEqual(JSON.parse(JSON.stringify(choice.clarification.choices)),
    [{index:0,choice:'child',childId:'child_khalit'}]);
  assert.deepEqual(choice.deletions,[]);
});
test('Другое: новое поступление can delete both existing profiles after publication',async()=>{
  const h=fakeModal(preview);
  const promise=h.window.MedsiReportClarifier.prepare({kind:'evening',text:'Арина — Рисовала.'});
  await h.choose('Другое');
  await h.choose('Да, новое поступление');
  await h.choose('Да, удалить всех');
  const choice=await promise;
  assert.equal(choice.clarification.choices[0].choice,'other-new');
  assert.equal(choice.deletions.length,2);
  const queued=[];
  h.window.MedsiOverlayTransport.parentDelete=async(_session,payload)=>{
    queued.push(payload);return {accepted:true,ok:true};
  };
  const warning=await h.window.MedsiReportClarifier.finish(choice.deletions,{token:'staff'});
  assert.equal(warning,'');
  assert.deepEqual(queued.map(x=>x.phone),['89000000001','89000000002','89000000003']);
});
test('Другое: not a new arrival does not delete or automatically assign a child',async()=>{
  const h=fakeModal(preview);
  const promise=h.window.MedsiReportClarifier.prepare({kind:'morning',text:'Арина — Разговор.'});
  await h.choose('Другое');
  await h.choose('Нет, разберёмся позже');
  const v=await promise;
  assert.deepEqual(JSON.parse(JSON.stringify(v.clarification.choices)),
    [{index:0,choice:'other-later'}]);
  assert.equal(v.deletions.length,0);
});
