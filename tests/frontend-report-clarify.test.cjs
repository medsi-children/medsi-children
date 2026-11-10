const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../tutors/report-clarify.js'),'utf8');

function fakeModal(preview){
  const dialogs=[],requests=[];
  const node=tag=>({
    tag,children:[],className:'',textContent:'',type:'',hidden:false,disabled:false,
    attributes:{},
    classList:{toggle(){},add(){},remove(){}},
    setAttribute(key,value){this.attributes[key]=value},
    append(...items){this.children.push(...items)},
    close(){this.closed=true},remove(){this.removed=true},
    showModal(){dialogs.push(this)},addEventListener(){},
  });
  const document={createElement:node,body:{append(){}}};
  const window={MedsiEducatorSession:{get:async()=>({token:'educator_signed'})},
    MedsiOverlayTransport:{parentDelete(){throw new Error('Unexpected parent deletion')}}};
  const ctx={window,document,fetch:async(url,opts)=>{
    requests.push({url,opts});
    assert.match(url,/report-clarify/);
    assert.equal(opts.headers['X-Medsi-Chat-Session'],'educator_signed');
    return {ok:true,json:async()=>preview};
  }};
  vm.createContext(ctx);
  vm.runInContext(source,ctx);
  const all=(root,tag)=>{const found=[];const walk=x=>{
    if(x.tag===tag)found.push(x);
    for(const child of x.children||[])walk(child);
  };walk(root);return found};
  const waitForDialog=async()=>{
    for(let i=0;i<24&&!dialogs.length;i++)await Promise.resolve();
    assert.ok(dialogs.length,'clarification should display exactly one dialog');
    return dialogs.at(-1);
  };
  const findButton=(dialog,label)=>all(dialog,'button').find(x=>x.textContent===label);
  const click=async(dialog,label)=>{
    const button=findButton(dialog,label);
    assert.ok(button,'Missing '+label+' in '+all(dialog,'button').map(x=>x.textContent).join(' | '));
    assert.equal(button.disabled,false,label+' should be enabled');
    button.onclick();await Promise.resolve();
    return button;
  };
  return {window,dialogs,requests,all,waitForDialog,findButton,click};
}
const preview={ok:true,token:'server-fingerprint',conflicts:[{
  index:0,name:'Арина',excerpt:'Арина: занималась творчеством.',
  candidates:[
    {childId:'child_khalit',name:'Арина Халитова',phones:['9000000001','9000000002']},
    {childId:'child_amina',name:'Арина Амелина',phones:['9000000003']}
  ]
}]};

test('original question, two visible children, and no extra discharge screen',async()=>{
  const h=fakeModal(preview);
  const result=h.window.MedsiReportClarifier.prepare({kind:'evening',text:'Арина — Рисовала.'});
  const dialog=await h.waitForDialog();
  const heading=h.all(dialog,'h3')[0];
  assert.equal(heading.textContent,'В отчете найден блок с именем Арина. Какой это ребенок?');
  assert.ok(h.findButton(dialog,'Арина Халитова'));
  assert.ok(h.findButton(dialog,'Арина Амелина'));
  const more=h.findButton(dialog,'Другое');
  assert.equal(more.attributes['aria-expanded'],'false');
  const alts=h.all(dialog,'div').find(x=>x.className.includes('medsi-clarify-alternatives'));
  assert.equal(alts.hidden,true,'new and unknown are collapsed by default');
  assert.equal(h.findButton(dialog,'Продолжить отправку').disabled,true);
  await h.click(dialog,'Арина Халитова');
  assert.equal(h.findButton(dialog,'Продолжить отправку').disabled,false);
  await h.click(dialog,'Продолжить отправку');
  const choice=await result;
  assert.deepEqual(JSON.parse(JSON.stringify(choice.clarification)),{
    token:'server-fingerprint',choices:[{index:0,choice:'child',childId:'child_khalit'}]
  });
  assert.equal(Object.hasOwn(choice,'deletions'),false);
  assert.equal(h.dialogs.length,1);
  assert.equal(h.window.MedsiReportClarifier.finish,undefined);
  assert.doesNotMatch(source,/parentDelete|выписал|Удалить детей/);
});

test('Другое expands once, new child selection submits without another question',async()=>{
  const h=fakeModal(preview);
  const result=h.window.MedsiReportClarifier.prepare({kind:'morning',text:'Арина — Рисовала.'});
  const dialog=await h.waitForDialog();
  await h.click(dialog,'Другое');
  const alt=h.all(dialog,'div').find(x=>x.className.includes('medsi-clarify-alternatives'));
  assert.equal(alt.hidden,false);
  assert.equal(h.findButton(dialog,'Другое').attributes['aria-expanded'],'true');
  await h.click(dialog,'Новый ребёнок');
  await h.click(dialog,'Продолжить отправку');
  const choice=await result;
  assert.deepEqual(JSON.parse(JSON.stringify(choice.clarification.choices)),
    [{index:0,choice:'other-new'}]);
  assert.equal(h.dialogs.length,1);
});

test('Другое allows unknown child; report text is kept unchanged for publisher',async()=>{
  const h=fakeModal(preview);
  const raw='Арина — Без фамилии и уточнений.';
  const result=h.window.MedsiReportClarifier.prepare({kind:'evening',text:raw});
  const dialog=await h.waitForDialog();
  await h.click(dialog,'Другое');
  await h.click(dialog,'Пока неизвестно');
  await h.click(dialog,'Продолжить отправку');
  const choice=await result;
  assert.deepEqual(JSON.parse(JSON.stringify(choice.clarification.choices)),
    [{index:0,choice:'other-later'}]);
  assert.equal(JSON.parse(h.requests[0].opts.body).text,raw);
});

test('editing uses the same question without declining an indeclinable child name',async()=>{
  const h=fakeModal({...preview,conflicts:[{
    ...preview.conflicts[0],name:'Мишель',
    candidates:[{childId:'one',name:'Мишель Смирнова'},
      {childId:'two',name:'Мишель Орлова'}]
  }]});
  const result=h.window.MedsiReportClarifier.prepare({
    kind:'morning',text:'Мишель — Рисовала.',publicationId:'existing_publication'
  });
  const dialog=await h.waitForDialog();
  assert.equal(h.all(dialog,'h3')[0].textContent,
    'В отчете найден блок с именем Мишель. Какой это ребенок?');
  await h.click(dialog,'Мишель Орлова');
  await h.click(dialog,'Сохранить изменения');
  const choice=await result;
  assert.equal(choice.clarification.choices[0].childId,'two');
  assert.equal(JSON.parse(h.requests[0].opts.body).publicationId,'existing_publication');
});

test('cancel does not publish, psychology needs no preflight',async()=>{
  const h=fakeModal(preview);
  const result=h.window.MedsiReportClarifier.prepare({kind:'morning',text:'Арина — Играла.'});
  const dialog=await h.waitForDialog();
  await h.click(dialog,'Отмена');
  await assert.rejects(result,/отменён/);
  assert.equal(h.dialogs.length,1);
  const therapy=await h.window.MedsiReportClarifier.prepare({kind:'psychology',text:'Занятие.'});
  assert.equal(therapy.clarification,null);
  assert.equal(h.requests.length,1);
});
