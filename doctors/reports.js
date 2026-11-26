(() => {
  'use strict';
  const byId=id=>document.getElementById(id);
  const icon = (paths) => '<svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  const library = document.createElement('section');
  library.id = 'medsiTutorReportLibrary';
  library.className = 'medsi-tutor-reports hidden';
  library.setAttribute('role', 'dialog');
  library.setAttribute('aria-modal', 'true');
  library.setAttribute('aria-labelledby', 'medsiReportsTitle');
  library.innerHTML = `
    <div class="medsi-reports-shell">
      <header class="medsi-reports-header">
        <button type="button" id="medsiReportsBack" class="medsi-reports-back">← <span>В меню</span></button>
        <h2 id="medsiReportsTitle">Отчёты и дети</h2>
        <button type="button" id="medsiReportsRefresh" class="medsi-reports-refresh" aria-label="Обновить отчёты">↻</button>
      </header>
      <div class="medsi-reports-switch" role="tablist" aria-label="Тип отчётов">
        <button type="button" id="medsiTabRaw" role="tab" aria-selected="true" aria-controls="medsiRawPane"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg><span>Исходные отчёты</span></button>
        <button type="button" id="medsiTabChildren" role="tab" aria-selected="false" aria-controls="medsiChildrenPane"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M2.5 20v-2a6.5 6.5 0 0 1 13 0v2"/><circle cx="17" cy="9" r="2.5"/><path d="M18 14a5 5 0 0 1 3.5 4.8V20"/></svg><span>Отчёты по детям</span></button>
      </div>

      <div id="medsiRawPane" role="tabpanel" aria-labelledby="medsiTabRaw" class="medsi-reports-content"></div>
      <div id="medsiChildrenPane" role="tabpanel" aria-labelledby="medsiTabChildren" class="medsi-reports-content hidden"></div>
    </div>`;
  document.body.append(library);

  function formatDisplayDate(value) {
    const match=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!match)return String(value||'');
    const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
    return Number.isNaN(date.getTime())?String(value||''):
      date.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
  }
  function reportTypeLabel(type) { return type==='morning'?'Утренний отчёт':type==='evening'?'Вечерний отчёт':'Психотерапия'; }
  function textNode(tag,className,value){const el=document.createElement(tag);el.className=className||'';el.textContent=String(value??'');return el;}
  const reportText=value=>String(value||'').trim()||'Отчёта пока нет.';
  const operationOverlay=document.createElement('div');
  operationOverlay.className='medsi-operation-overlay hidden';
  operationOverlay.setAttribute('role','status');
  operationOverlay.setAttribute('aria-label','Загрузка');
  operationOverlay.innerHTML='<div class="medsi-operation-card"><div class="boot-spinner" aria-hidden="true"></div></div>';
  const operationNotice=document.createElement('div');
  operationNotice.className='medsi-operation-notice hidden';
  operationNotice.setAttribute('role','status');
  operationNotice.setAttribute('aria-live','polite');
  document.body.append(operationOverlay,operationNotice);
  let pendingOperations=0,noticeTimer=null;
  function beginOperation(){
    pendingOperations++;
    operationOverlay.classList.remove('hidden');
    library.setAttribute('aria-busy','true');
  }
  function endOperation(){
    pendingOperations=Math.max(0,pendingOperations-1);
    if(pendingOperations)return;
    operationOverlay.classList.add('hidden');
    library.removeAttribute('aria-busy');
  }
  function notifyOperation(message){
    const text=String(message||'').trim();
    if(!text)return;
    clearTimeout(noticeTimer);
    operationNotice.textContent=text;
    operationNotice.classList.remove('hidden');
    noticeTimer=setTimeout(()=>operationNotice.classList.add('hidden'),3500);
  }
  function splitSourceChildBlocks(value){
    const lines=String(value||'').split('\n'),parts=[];
    const header=/^([А-ЯЁ][А-ЯЁа-яё-]{1,48}(?:\s+[А-ЯЁ][а-яё-]{0,38}\.?)?)\s*[—–:：-]\s*(.*)$/u;
    for(const line of lines){
      const candidate=line.replace(/^[^\p{L}\p{N}]+/u,'');
      const decorated=/^([А-ЯЁа-яё-]{2,70})[ \t!！﹗‼⁈⁉❗❕❢❣\uFE0E\uFE0F]*(?:([А-ЯЁа-яё-]{1,100}\.?)[ \t!！﹗‼⁈⁉❗❕❢❣\uFE0E\uFE0F]*)?([:：—–-])([ \t]*)(.*)$/u.exec(candidate);
      const heading=decorated?decorated[1]+(decorated[2]?' '+decorated[2]:'')+decorated[3]+decorated[4]+decorated[5]:line;
      const match=heading.match(header);
      const ambiguous=match&&/^(?:Общий|Общие|Комментарий|Для|Сегодня|Занятие)$/iu.test(match[1].split(/\s+/)[0]);
      if(match&&!ambiguous){
        parts.push({type:'child',name:match[1],content:match[2]});
      }else if(parts.length&&parts[parts.length-1].type==='child'){
        parts[parts.length-1].content+='\n'+line;
      }else if(parts.length&&parts[parts.length-1].type==='plain'){
        parts[parts.length-1].content+='\n'+line;
      }else{
        parts.push({type:'plain',content:line});
      }
    }
    return parts;
  }
  function renderSourceChildPreview(target,value){
    const parts=splitSourceChildBlocks(value);
    if(!parts.some(part=>part.type==='child'))return;
    target.classList.add('medsi-source-children');
    target.replaceChildren();
    for(const part of parts){
      if(part.type==='plain'){
        if(part.content.trim())target.append(textNode('div','medsi-source-plain',part.content));
        continue;
      }
      const block=textNode('div','medsi-source-child-block','');
      const title=textNode('span','medsi-source-child-name',part.name);
      const divider=textNode('span','medsi-source-child-divider',' — ');
      const content=textNode('span','medsi-source-child-text',part.content);
      block.append(title,divider,content);
      target.append(block);
    }
  }

  function inlineReport(value,label,kind){
    const wrap=textNode('div','medsi-inline-report','');
    const body=textNode('div','medsi-report-body',reportText(value));
    if(kind==='morning'||kind==='evening')renderSourceChildPreview(body,value);
    wrap.append(body);
    return wrap;
  }
  function renderRaw(data){
    const root=byId('medsiRawPane');root.replaceChildren();
    for(const kind of ['morning','evening','psychology']){
      const entry=data.raw?.[kind]||{},card=textNode('article','medsi-raw-report medsi-raw-'+kind,'');
      const header=textNode('header','medsi-raw-header',''),heading=textNode('div','medsi-raw-heading','');
      const sym=textNode('span','medsi-raw-symbol','');
      sym.innerHTML=kind==='morning'?icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'):
        kind==='evening'?icon('<path d="M20.5 15.5A9 9 0 0 1 8.5 3.5a9 9 0 1 0 12 12Z"/><path d="M17 3v4M15 5h4"/>'):
        icon('<path d="M12 5a4 4 0 0 0-7 3 4 4 0 0 0 0 8 4 4 0 0 0 7 3"/><path d="M12 5a4 4 0 0 1 7 3 4 4 0 0 1 0 8 4 4 0 0 1-7 3M12 5v14"/>');
      heading.append(textNode('h3','',reportTypeLabel(kind)),textNode('p','medsi-report-date',entry.reportDate?formatDisplayDate(entry.reportDate):'Публикации пока нет'));
      header.append(sym,heading);
      if(entry.publicationId){
        const copy=textNode('button','medsi-report-copy','');
        copy.type='button';copy.setAttribute('aria-label','Скопировать '+reportTypeLabel(kind).toLowerCase());copy.title='Скопировать отчёт';
        copy.innerHTML=icon('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>');
        copy.onclick=async()=>{try{await navigator.clipboard.writeText(String(kind==='psychology'?entry.rawText:(entry.displayText||entry.normalizedText||entry.rawText||'')));notifyOperation('Отчёт скопирован.');}catch(_){notifyOperation('Не удалось скопировать. Проверьте разрешение браузера.');}};
        header.append(copy);
      }
      card.append(header);
      const wave=document.createElementNS('http://www.w3.org/2000/svg','svg');
      wave.setAttribute('viewBox','0 0 300 96');wave.setAttribute('preserveAspectRatio','none');wave.setAttribute('aria-hidden','true');wave.setAttribute('class','medsi-raw-wave');
      wave.innerHTML='<path d="M55 0h245v70C204 25 146 105 55 0Z"/><path d="M130 0h170v48C250 0 218 68 130 0Z"/>';
      card.append(wave);
      if(entry.publicationId){
        card.classList.add('medsi-raw-collapsed');
        card.append(inlineReport(
          kind==='psychology'?entry.rawText:(entry.displayText||entry.normalizedText||entry.rawText||''),
          reportTypeLabel(kind),kind));
        const toggle=textNode('button','medsi-raw-expand','');
        toggle.type='button';toggle.setAttribute('aria-label','Развернуть отчёт');toggle.setAttribute('aria-expanded','false');
        toggle.onclick=()=>{const open=card.classList.toggle('medsi-raw-expanded');toggle.setAttribute('aria-label',open?'Свернуть отчёт':'Развернуть отчёт');toggle.setAttribute('aria-expanded',String(open));};
        card.append(toggle);
      }else card.append(textNode('div','medsi-report-body','Отчёта пока нет.'));
      root.append(card);
    }
  }
  let childPageIndex=0;
  function renderChildren(data){
    const pane=byId('medsiChildrenPane');pane.replaceChildren();
    const children=Array.isArray(data.children)?data.children:[];
    if(!children.length){pane.append(textNode('p','medsi-reports-empty','В базе пока нет активных детей.'));return;}
    childPageIndex=Math.max(0,Math.min(childPageIndex,children.length-1));
    const child=children[childPageIndex];
    const navigation=textNode('section','medsi-child-deck-nav','');
    const previous=textNode('button','medsi-child-nav-arrow',''),next=textNode('button','medsi-child-nav-arrow','');
    for(const button of [previous,next]){button.type='button';button.innerHTML=icon('<path d="M19 12H5M12 19l-7-7 7-7"/>');}
    next.classList.add('medsi-child-nav-next');
    previous.setAttribute('aria-label','Предыдущий ребёнок');next.setAttribute('aria-label','Следующий ребёнок');
    previous.disabled=childPageIndex===0;next.disabled=childPageIndex===children.length-1;
    previous.onclick=()=>{childPageIndex=Math.max(0,childPageIndex-1);renderChildren(data);};
    next.onclick=()=>{childPageIndex=Math.min(children.length-1,childPageIndex+1);renderChildren(data);};
    const identity=textNode('div','medsi-child-deck-identity','');
    const names=textNode('div','medsi-child-deck-name','');
    names.append(textNode('h3','',child.childName||'Без имени'),textNode('p','',child.surname||''));
    identity.append(names);
    const details=textNode('div','medsi-child-deck-details','');
    const detailIcon={
      parent:icon('<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>'),
      child:icon('<circle cx="12" cy="12" r="8"/><path d="M9 11h.01M15 11h.01M9 15c2 2 4 2 6 0"/>'),
      phone:icon('<path d="M7 3 4 5c-1 2 2 8 6 12s10 7 12 6l2-3-6-4-3 3c-4-2-7-5-9-9l3-3-2-4Z"/>')
    };
    const detailRow=(symbol,label,value)=>{
      const line=textNode('div','medsi-child-deck-detail-row',''),mark=textNode('span','medsi-child-deck-detail-icon','');
      mark.innerHTML=detailIcon[symbol];
      const copy=textNode('span','medsi-child-deck-detail-copy','');
      if(label)copy.append(textNode('span','',label+' '));
      copy.append(textNode('strong','',value||'—'));
      line.append(mark,copy);return line;
    };
    const linkedParents=Array.isArray(child.parents)?child.parents:[];
    for(const parent of linkedParents){
      details.append(detailRow('parent',parent.relationship||'Родитель',String(parent.parentName||'').trim().split(/\s+/u)[0]||'—'));
      if(parent.phone)details.append(detailRow('phone','',parent.phone));
    }
    details.append(detailRow('child','Ребёнок:',child.childName||'—'));
    if(!linkedParents.length)details.append(detailRow('parent','','Родитель не привязан'));
    identity.append(details);
    navigation.append(previous,identity,next);
    pane.append(navigation);
    pane.append(textNode('p','medsi-child-deck-progress',(childPageIndex+1)+' / '+children.length));
    const views=Array.isArray(child.parentViews)?child.parentViews:[];
    for(const view of views){
      const block=textNode('article','medsi-child-deck-reports','');
      if(views.length>1)block.append(textNode('h4','medsi-view-parent',String(view.parentName||'').trim().split(/\s+/u)[0]||view.phone||'Родитель'));
      for(const kind of ['morning','evening']){
        const current=view.reports?.[kind]||'';
        const section=textNode('section','medsi-child-report-section medsi-child-report-section-'+kind,'');
        const heading=textNode('h5','medsi-child-report-pill',''),symbol=textNode('span','medsi-child-report-pill-icon','');
        symbol.innerHTML=kind==='morning'
          ?icon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')
          :icon('<path d="M20.5 15.5A9 9 0 0 1 8.5 3.5a9 9 0 1 0 12 12Z"/>');
        heading.append(symbol,document.createTextNode(reportTypeLabel(kind)));
        section.append(heading);
        section.append(inlineReport(current,reportTypeLabel(kind),''));
        block.append(section);
      }
      pane.append(block);
    }
    if(!views.length)pane.append(textNode('p','medsi-reports-empty','Для ребёнка пока нет распределённых отчётов.'));
  }

  let controller;
  const open=async()=>{
    controller?.abort();
    controller=new AbortController();
    const current=controller;
    library.classList.remove('hidden');
    document.body.classList.add('medsi-report-library-open');
    beginOperation();
    try {
      const data=await MedsiDoctors.request('/reports',{signal:current.signal});
      if (!current.signal.aborted) {renderRaw(data);renderChildren(data);}
    } catch {
      if (!current.signal.aborted) notifyOperation('Не удалось загрузить отчёты.');
    } finally {endOperation();}
  };
  const close=()=>{
    controller?.abort();
    library.classList.add('hidden');
    document.body.classList.remove('medsi-report-library-open');
    byId('doctorReports').focus();
  };
  byId('doctorReports').onclick=open;
  byId('medsiReportsRefresh').onclick=open;
  byId('medsiReportsBack').onclick=close;
  library.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  for (const [key,pane] of [['Raw','Raw'],['Children','Children']]) {
    byId('medsiTab'+key).onclick=()=>{
      for(const other of ['Raw','Children']){
        byId('medsiTab'+other).setAttribute('aria-selected',String(pane===other));
        byId('medsi'+other+'Pane').classList.toggle('hidden',pane!==other);
      }
    };
  }
})();
