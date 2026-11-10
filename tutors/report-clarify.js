(function(){
  'use strict';
  if(window.MedsiReportClarifier)return;
  const el=(tag,className,text)=>{
    const node=document.createElement(tag);node.className=className||'';
    if(text!==undefined)node.textContent=String(text);
    return node;
  };
  const onlyUnique=values=>[...new Set(values.filter(Boolean))];
  const stop=()=>Object.assign(new Error('Выбор получателя отменён. Отчёт не отправлен.'),{
    code:'REPORT_CLARIFICATION_CANCELLED'
  });
  // A modal never changes the report text. Identifiers are accepted only
  // after a second live-roster check inside the PostgreSQL transaction.
  function question(title,description,options){
    return new Promise((resolve,reject)=>{
      const dialog=el('dialog','medsi-clarify-dialog');
      const content=el('div','medsi-clarify-content');
      content.append(el('h3','',title));
      if(description)content.append(el('p','medsi-clarify-excerpt',description));
      const choices=el('div','medsi-clarify-options');
      const exit=selection=>{
        dialog.close();dialog.remove();resolve(selection);
      };
      for(const option of options){
        const button=el('button','medsi-clarify-choice',option.label);
        button.type='button';button.onclick=()=>exit(option.value);
        choices.append(button);
      }
      content.append(choices);
      const cancel=el('button','medsi-clarify-cancel','Отменить отправку');
      cancel.type='button';cancel.onclick=()=>exit(null);content.append(cancel);
      dialog.append(content);
      dialog.addEventListener('cancel',event=>{event.preventDefault();exit(null)});
      document.body.append(dialog);
      try{dialog.showModal()}catch(err){dialog.remove();reject(err)}
    });
  }
  async function previewReport({kind,text,publicationId}){
    const session=await window.MedsiEducatorSession.get();
    const response=await fetch('/lab/report-clarify',{
      method:'POST',cache:'no-store',
      headers:{'content-type':'application/json','X-Medsi-Chat-Session':session.token},
      body:JSON.stringify({kind,text,publicationId:publicationId||''})
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok||!data?.ok)throw new Error(
      data?.message||'Не удалось проверить имена детей. Повторите отправку.');
    return data;
  }
  async function prepare({kind,text,publicationId=''}) {
    if(kind==='psychology')return {clarification:null,deletions:[]};
    const review=await previewReport({kind,text,publicationId});
    if(!review.conflicts.length)return {clarification:null,deletions:[]};
    const choices=[],deleteByChild=new Map();
    for(const conflict of review.conflicts){
      const childOptions=conflict.candidates.map(child=>({
        label:child.name,value:'child:'+child.childId
      }));
      const answer=await question(
        'Кому принадлежит блок «'+conflict.name+'»?',
        conflict.excerpt||'',[
          ...childOptions,{label:'Другое',value:'other'}
        ]);
      if(answer===null)throw stop();
      if(answer!=='other'){
        const selected=conflict.candidates.find(child=>answer==='child:'+child.childId);
        if(!selected)throw stop();
        choices.push({index:conflict.index,choice:'child',childId:selected.childId});
        const others=conflict.candidates.filter(c=>c.childId!==selected.childId);
        if(!others.length)continue;
        const names=others.map(c=>c.name).join(', ');
        const discharge=await question(
          others.length===1?names+' выписалась?':names+' выписались?',
          'Удаление закроет доступ родителям выбранных детей и удалит их переписки.',[
            {label:'Да, удалить из бота',value:'yes'},
            {label:'Нет, оставить',value:'no'}
          ]);
        if(discharge===null)throw stop();
        if(discharge==='yes')for(const child of others)deleteByChild.set(child.childId,child);
        continue;
      }
      const newArrival=await question('Это новое поступление?',
        'Пока не будем назначать блок ни одному из зарегистрированных родителей.',[
          {label:'Да, новое поступление',value:'yes'},
          {label:'Нет, разберёмся позже',value:'no'}
        ]);
      if(newArrival===null)throw stop();
      choices.push({index:conflict.index,
        choice:newArrival==='yes'?'other-new':'other-later'});
      if(newArrival!=='yes'||!conflict.candidates.length)continue;
      const existing=conflict.candidates;
      const names=existing.map(c=>c.name).join(' и ');
      const answerRemoval=await question(
        'Удалить '+(existing.length===1?'ребёнка ':'детей ')+names+' из бота?',
        'Сначала сохраним отчёт. Удаление отдельно закроет доступ и очистит чаты.',[
          {label:existing.length===1?'Да, удалить':'Да, удалить всех',value:'all'},
          ...(existing.length>1?[{label:'Удалить только одного',value:'one'}]:[]),
          {label:'Нет, оставить',value:'none'}
        ]);
      if(answerRemoval===null)throw stop();
      if(answerRemoval==='all')for(const child of existing)deleteByChild.set(child.childId,child);
      if(answerRemoval==='one'){
        const which=await question('Кого удалить?',null,[
          ...existing.map(c=>({label:c.name,value:c.childId}))
        ]);
        if(which===null)throw stop();
        const selected=existing.find(c=>c.childId===which);
        if(selected)deleteByChild.set(selected.childId,selected);
      }
    }
    return {
      clarification:{token:review.token,choices},
      deletions:[...deleteByChild.values()].map(c=>({
        childId:c.childId,name:c.name,phones:onlyUnique(c.phones||[])
      }))
    };
  }
  async function finish(deletions,session) {
    if(!deletions?.length)return '';
    const transport=window.MedsiOverlayTransport;
    if(!transport?.parentDelete)return 'Удаление детей не выполнено: нет подключения.';
    const missing=[];
    const processed=new Set();
    for(const child of deletions){
      if(!child.phones?.length){missing.push(child.name);continue}
      for(const phone of child.phones){
        if(processed.has(phone))continue;
        processed.add(phone);
        const operationId='del_'+crypto.randomUUID().replace(/-/g,'');
        try{
          const result=await transport.parentDelete(session,{
            phone:'8'+String(phone).replace(/\D/g,'').slice(-10),operationId
          });
          if(result?.accepted!==true)missing.push(child.name);
        }catch(error){missing.push(child.name)}
      }
    }
    window.MedsiEducatorPrewarm?.clear?.();
    return missing.length
      ?'Отчёт сохранён, но удаление не подтверждено для: '+onlyUnique(missing).join(', ')+'. Проверьте раздел «Дети и родители».'
      :'';
  }
  window.MedsiReportClarifier=Object.freeze({prepare,finish});
})();
