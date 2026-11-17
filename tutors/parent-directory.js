(function(){
  'use strict';
  if(document.getElementById('medsiParentDirectoryDialog'))return;
  const overlay=document.createElement('div');
  overlay.id='medsiParentDirectoryDialog';
  overlay.className='medsi-directory-overlay hidden';
  overlay.setAttribute('role','dialog');
  overlay.setAttribute('aria-modal','true');
  overlay.setAttribute('aria-labelledby','medsiDirectoryTitle');
  overlay.innerHTML=`
    <section class="medsi-directory-panel">
      <header class="medsi-directory-header">
        <div>
          <h2 id="medsiDirectoryTitle">База родителей</h2>
          <p>Контакты сохраняются после выписки ребёнка.</p>
        </div>
        <button id="medsiDirectoryClose" type="button" aria-label="Закрыть">×</button>
      </header>
      <div class="medsi-directory-controls">
        <input type="search" id="medsiDirectorySearch" placeholder="Поиск по ребёнку, родителю или телефону" aria-label="Поиск по базе родителей">
        <div class="medsi-directory-tools">
          <span id="medsiDirectoryCount" role="status">Загрузка записей…</span>
          <button type="button" id="medsiDirectoryImport" class="medsi-directory-import">Импорт CSV</button>
          <input type="file" id="medsiDirectoryFile" accept=".csv,text/csv" class="hidden">
        </div>
        <p class="medsi-directory-help">В архив попадают новые регистрации. Сохранённую старую базу можно импортировать из CSV один раз. Совпадающие номера автоматически объединяются: один телефон, одна запись.</p>
        <p id="medsiDirectoryFeedback" role="status" class="medsi-directory-feedback"></p>
      </div>
      <div id="medsiDirectoryList" class="medsi-directory-list"></div>
    </section>`;
  document.body.appendChild(overlay);
  const id=name=>document.getElementById(name);
  const search=id('medsiDirectorySearch'),list=id('medsiDirectoryList');
  const count=id('medsiDirectoryCount'),feedback=id('medsiDirectoryFeedback');
  const close=id('medsiDirectoryClose'),importButton=id('medsiDirectoryImport');
  const fileInput=id('medsiDirectoryFile');
  let records=[],busy=false;
  const norm=v=>String(v??'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').trim();
  function setBusy(v){busy=v;importButton.disabled=v;close.disabled=v}
  async function request(path,{method='GET',body}={}){
    const session=await window.MedsiEducatorSession.get();
    if(!session?.token)throw new Error('Сначала войдите в панель воспитателя.');
    const response=await fetch(path,{
      method,cache:'no-store',
      headers:{'X-Medsi-Chat-Session':session.token,...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok||!result?.ok)throw new Error(result?.message||'Не удалось загрузить базу.');
    return result;
  }
  function childTitle(row){
    const name=String(row.childName||'').trim(),surname=String(row.childSurname||'').trim();
    if(!surname)return name||'Имя ребёнка не указано';
    const parts=name.split(/\s+/);
    const last=parts[parts.length-1]||'';
    const lowerLast=last.toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
    const lowerSurname=surname.toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
    if(lowerLast===lowerSurname)return name;
    if(last.length===1&&lowerLast===lowerSurname[0])parts.pop();
    return [...parts,surname].filter(Boolean).join(' ');
  }
  function render(){
    const value=norm(search.value);
    const matched=records.filter(row=>!value||
      norm([row.childName,row.childSurname,row.parentName,row.phone].join(' ')).includes(value));
    count.textContent='Записей: '+records.length+(value?' · найдено: '+matched.length:'');
    list.replaceChildren();
    if(!matched.length){const empty=document.createElement('p');empty.className='medsi-directory-empty';empty.textContent='Совпадений нет.';list.appendChild(empty);return}
    matched.forEach(row=>{
      const card=document.createElement('article');card.className='medsi-directory-entry';
      const info=document.createElement('div');info.className='medsi-directory-info';
      const title=document.createElement('strong');title.className='medsi-directory-child';title.textContent=childTitle(row);
      const parent=document.createElement('span');parent.className='medsi-directory-parent';parent.textContent='Родитель '+row.parentName;
      const phone=document.createElement('span');phone.className='medsi-directory-phone';phone.textContent='Телефон: +'+row.phone;
      info.append(title,parent,phone);
      const remove=document.createElement('button');remove.type='button';remove.className='medsi-directory-remove';
      remove.setAttribute('aria-label','Удалить запись из базы родителей');
      remove.title='Удалить запись';
      remove.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
      remove.onclick=async()=>{
        if(busy||!window.confirm('Удалить эту запись только из «Базы родителей»? Активный профиль ребёнка и переписка не изменятся.'))return;
        setBusy(true);feedback.textContent='Удаляем запись…';
        try{
          await request('/lab/admin/parent-directory/'+encodeURIComponent(row.entryId),{method:'DELETE'});
          records=records.filter(x=>x.entryId!==row.entryId);
          feedback.textContent='Запись удалена из базы родителей.';render();
        }catch(error){feedback.textContent=error.message}
        finally{setBusy(false)}
      };
      card.append(info,remove);list.appendChild(card);
    });
  }
  async function load(){
    feedback.textContent='';count.textContent='Загружаем базу родителей…';setBusy(true);
    try{
      const data=await request('/lab/admin/parent-directory');
      records=Array.isArray(data.rows)?data.rows:[];
      render();
    }catch(error){feedback.textContent=error.message;count.textContent='База недоступна'}
    finally{setBusy(false)}
  }
  function parseCsv(text){
    const raw=String(text||'').replace(/^\uFEFF/,'');
    const firstLine=raw.split(/\r?\n/,1)[0]||'';
    const sep=(firstLine.match(/;/g)||[]).length>(firstLine.match(/,/g)||[]).length?';':',';
    const rows=[];let row=[],field='',quoted=false;
    for(let i=0;i<raw.length;i++){
      const ch=raw[i];
      if(ch==='"'){
        if(quoted&&raw[i+1]==='"'){field+='"';i++}
        else quoted=!quoted;
      }else if(ch===sep&&!quoted){row.push(field);field=''}
      else if((ch==='\n'||ch==='\r')&&!quoted){
        if(ch==='\r'&&raw[i+1]==='\n')i++;
        row.push(field);field='';
        if(row.some(v=>v.trim()))rows.push(row);
        row=[];
      }else field+=ch;
    }
    row.push(field);
    if(row.some(v=>v.trim()))rows.push(row);
    const headers=rows.shift()?.map(v=>v.trim().toLocaleUpperCase('ru-RU'))||[];
    const expected=['НОМЕР ТЕЛЕФОНА','ИМЯ РОДИТЕЛЯ','ИМЯ РЕБЕНКА','ФАМИЛИЯ РЕБЕНКА'];
    if(!expected.every((value,i)=>headers[i]===value))
      throw new Error('Нужен CSV с четырьмя колонками из старого справочника.');
    if(!rows.length||rows.length>500)throw new Error('Файл должен содержать от 1 до 500 записей.');
    return rows.map((cols,i)=>({
      phone:String(cols[0]||'').trim(),parentName:String(cols[1]||'').trim(),
      childName:String(cols[2]||'').trim(),childSurname:String(cols[3]||'').trim(),
      sourceRow:i+2
    }));
  }
  const shut=()=>{if(busy)return;overlay.classList.add('hidden')};
  close.onclick=shut;
  overlay.addEventListener('click',event=>{if(event.target===overlay)shut()});
  overlay.addEventListener('keydown',event=>{if(event.key==='Escape')shut()});
  search.addEventListener('input',render);
  importButton.onclick=()=>fileInput.click();
  fileInput.onchange=async()=>{
    const file=fileInput.files?.[0];fileInput.value='';if(!file)return;
    try{
      if(file.size>500*1024)throw new Error('CSV слишком большой. Максимум 500 КБ.');
      const rows=parseCsv(await file.text());
      if(!window.confirm('Импортировать '+rows.length+' исторических записей в отдельную «Базу родителей»?'))return;
      setBusy(true);feedback.textContent='Импортируем архив…';
      const result=await request('/lab/admin/parent-directory/import',{method:'POST',body:{rows}});
      feedback.textContent='Импортировано: '+result.inserted+'. Уже были в базе: '+result.skipped+'.';
      await load();
      feedback.textContent='Импортировано: '+result.inserted+'. Уже были в базе: '+result.skipped+'.';
    }catch(error){feedback.textContent=error.message}
    finally{setBusy(false)}
  };
  // The settings tile may be created after this script has loaded.
  document.addEventListener('click',event=>{
    const tile=event.target.closest('#medsiParentDirectoryCard');
    if(!tile)return;
    id('tutorSettingsClose')?.click();
    overlay.classList.remove('hidden');
    search.value='';records=[];list.replaceChildren();load();search.focus();
  });
})();
