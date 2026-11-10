(function(){
  'use strict';
  if(window.MedsiReportClarifier)return;
  const el=(tag,className,text)=>{
    const node=document.createElement(tag);node.className=className||'';
    if(text!==undefined)node.textContent=String(text);
    return node;
  };
  const stop=()=>Object.assign(new Error('Выбор получателя отменён. Отчёт не отправлен.'),{
    code:'REPORT_CLARIFICATION_CANCELLED'
  });
  // One brief question per ambiguous block. No discharge/deletion actions:
  // clinical report delivery and parent profile lifecycle are separate tasks.
  function clarifyBlock(conflict,{editing=false}={}){
    return new Promise((resolve,reject)=>{
      const dialog=el('dialog','medsi-clarify-dialog');
      const content=el('div','medsi-clarify-content');
      const title=el('h3','',
        'В отчете найден блок с именем '+String(conflict.name||'')+'. Какой это ребенок?');
      content.append(title);
      const options=el('div','medsi-clarify-options');
      const alternatives=el('div','medsi-clarify-options medsi-clarify-alternatives');
      alternatives.hidden=true;
      const more=el('button','medsi-clarify-more','Другое');
      more.type='button';more.setAttribute('aria-expanded','false');
      more.setAttribute('aria-controls','medsi-report-clarify-alternatives');
      alternatives.id='medsi-report-clarify-alternatives';
      const submit=el('button','medsi-clarify-continue',
        editing?'Сохранить изменения':'Продолжить отправку');
      submit.type='button';submit.disabled=true;
      let selected=null,closed=false;
      const allChoices=[];
      const addChoice=(container,label,decision)=>{
        const button=el('button','medsi-clarify-choice',label);
        button.type='button';
        button.setAttribute('aria-pressed','false');
        allChoices.push(button);
        button.onclick=()=>{
          selected=decision;
          for(const other of allChoices){
            const current=other===button;
            other.classList.toggle('is-selected',current);
            other.setAttribute('aria-pressed',String(current));
          }
          submit.disabled=false;
        };
        container.append(button);
      };
      for(const child of conflict.candidates||[]){
        addChoice(options,child.name,{index:conflict.index,
          choice:'child',childId:child.childId});
      }
      addChoice(alternatives,'Новый ребёнок',
        {index:conflict.index,choice:'other-new'});
      addChoice(alternatives,'Пока неизвестно',
        {index:conflict.index,choice:'other-later'});
      more.onclick=()=>{
        alternatives.hidden=!alternatives.hidden;
        const expanded=!alternatives.hidden;
        more.classList.toggle('is-expanded',expanded);
        more.setAttribute('aria-expanded',String(expanded));
      };
      const done=value=>{
        if(closed)return;
        closed=true;
        dialog.close();dialog.remove();resolve(value);
      };
      submit.onclick=()=>{if(selected)done(selected)};
      const cancel=el('button','medsi-clarify-cancel','Отмена');
      cancel.type='button';cancel.onclick=()=>done(null);
      const footer=el('div','medsi-clarify-footer');
      footer.append(submit,cancel);
      content.append(options,more,alternatives,footer);
      dialog.append(content);
      dialog.addEventListener('cancel',event=>{event.preventDefault();done(null)});
      document.body.append(dialog);
      try{dialog.showModal()}catch(error){dialog.remove();reject(error)}
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
    if(kind==='psychology')return {clarification:null};
    const review=await previewReport({kind,text,publicationId});
    if(!review.conflicts.length)return {clarification:null};
    const choices=[];
    for(const conflict of review.conflicts){
      const choice=await clarifyBlock(conflict,{editing:!!publicationId});
      if(choice===null)throw stop();
      choices.push(choice);
    }
    // Keep the original source untouched. The server checks every selected
    // child ID and the live roster token in the publication transaction.
    return {clarification:{token:review.token,choices}};
  }
  window.MedsiReportClarifier=Object.freeze({prepare});
})();
