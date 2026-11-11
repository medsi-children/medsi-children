(function(){
  const api=window.MedsiEducatorOverlayChat;
  const transport=window.MedsiOverlayTransport;
  if(!api||!transport||api.__medsiNewChatWrapped)return;
  api.__medsiNewChatWrapped=true;

  const phone10=v=>String(v||'').replace(/\D+/g,'').slice(-10);
  const displayPhone=v=>{const p=phone10(v);return p?'8'+p:''};
  const shortName=v=>String(v||'').trim().split(/\s+/u)[0]||'—';
  const deleteIcon=()=>'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
  const rowsSignature=rows=>(Array.isArray(rows)?rows:[]).map(r=>[phone10(r&&r.phone),String(r&&r.parentName||''),String(r&&r.childName||''),String(r&&r.relationship||'')].join('|')).sort().join('||');

  if(!transport.__medsiForcedParentWrapped){
    transport.__medsiForcedParentWrapped=true;
    const originalChats=transport.chats.bind(transport);
    transport.chats=async function(session,bucket,options){
      const res=await originalChats(session,bucket,options);
      const forced=window.__medsiForcedEducatorParent;
      if(forced&&res&&Array.isArray(res.chats)&&!res.chats.some(x=>phone10(x&&x.phone)===phone10(forced.phone))){
        res.chats.push({
          phone:phone10(forced.phone),
          parentName:forced.parentName||'',
          childName:forced.childName||'',
          relationship:forced.relationship||'Родитель',
          lastSide:'',lastType:'text',lastText:'Нет сообщений',hasUnread:false,pinnedBucket:''
        });
      }
      return res;
    };
  }

  function skeleton(count=4){
    return '<div class="list-skeleton">'+Array.from({length:count}).map(()=>'<div class="skeleton-card"><div class="skeleton-line title"></div><div class="skeleton-line wide"></div><div class="skeleton-line mid"></div><div class="skeleton-line short"></div><div class="skeleton-line wide" style="margin-top:16px;"></div><div class="skeleton-line mid"></div></div>').join('')+'</div>';
  }

  const originalMount=api.mount.bind(api);
  api.mount=function(overlay,state){
    const originalCleanup=originalMount(overlay,state);
    let disposed=false,rowsCache=null,renderedSignature='',requestToken=0,bridgeTimer=null;
    const root=overlay.root;
    const scene=root&&root.querySelector('.scene');
    const title=root&&root.querySelector('#title');
    const meta=root&&root.querySelector('#meta');
    const screenChats=root&&root.querySelector('#screenChats');
    const screenThread=root&&root.querySelector('#screenChatThread');
    const btnNew=root&&root.querySelector('#btnNewChat');
    const btnRefresh=root&&root.querySelector('#btnRefreshChats');
    const deleteModal=root&&root.querySelector('#childDeleteModal');
    if(!scene||!title||!meta||!screenChats||!screenThread||!btnNew||!btnRefresh)return originalCleanup;

    const screen=document.createElement('section');
    screen.id='screenNewChat';screen.className='hidden';
    const list=document.createElement('div');list.id='parentsList';list.className='chat-list';
    const error=document.createElement('p');error.id='parentsError';error.className='error hidden';
    const row=document.createElement('div');row.className='row new-chat-back-row';row.style.marginBottom='14px';
    const back=document.createElement('button');back.id='btnParentsBack';back.className='btn soft-back-btn';back.textContent='← Назад в меню';
    row.appendChild(back);screen.append(row,list,error);scene.insertBefore(screen,screenThread);

    function showNew(){
      document.body.dataset.screen='screenNewChat';
      title.textContent='Написать родителю';meta.textContent='Выберите родителя.';
      screenChats.classList.add('hidden');screenThread.classList.add('hidden');screen.classList.remove('hidden');
      requestAnimationFrame(()=>screen.classList.add('overlay-screen-ready'));
    }
    function showChats(){
      document.body.dataset.screen='screenChats';
      title.textContent='Чат с родителями';meta.textContent='Выберите чат с нужным родителем.';
      screen.classList.add('hidden');screen.classList.remove('overlay-screen-ready');screenThread.classList.add('hidden');screenChats.classList.remove('hidden');
      requestAnimationFrame(()=>screenChats.classList.add('overlay-screen-ready'));
      document.dispatchEvent(new Event('medsi:refresh-educator-chats'));
    }
    function render(rows){
      list.replaceChildren();rows=Array.isArray(rows)?rows:[];
      renderedSignature=rowsSignature(rows);
      if(!rows.length){list.innerHTML='<div class="chat-empty">Нет родителей.</div>';return}
      rows.forEach(r=>{
        const card=document.createElement('button');card.className='chat-card';card.type='button';card.dataset.phone=r.phone||'';
        const name=document.createElement('div');name.className='chat-card-title';name.textContent=r.childName||'Без имени ребёнка';
        const info=document.createElement('div');info.className='chat-card-meta';info.textContent='Родитель: '+shortName(r.parentName)+'\nРебёнок: '+shortName(r.childName)+'\nНомер телефона: '+(r.phone?displayPhone(r.phone):'—');
        card.append(name,info);
        card.addEventListener('click',()=>bridgeToCard(r,'open'));
        list.appendChild(card);
      });
    }
    async function loadParents(){
      const token=++requestToken;error.classList.add('hidden');
      if(rowsCache){
        if(renderedSignature!==rowsSignature(rowsCache))render(rowsCache);
      }else{
        list.innerHTML=skeleton(4);
        renderedSignature='';
      }
      try{
        const res=await transport.parents(state.session);
        if(disposed||token!==requestToken)return;
        const nextRows=Array.isArray(res&&res.parents)?res.parents:[];
        const nextSignature=rowsSignature(nextRows);
        rowsCache=nextRows;
        if(nextSignature!==renderedSignature)render(rowsCache);
      }catch(err){
        if(disposed||token!==requestToken)return;
        list.replaceChildren();renderedSignature='';
        error.textContent=(err&&err.message)||'Не удалось загрузить список родителей.';
        error.classList.remove('hidden');
      }
    }
    function findChatCard(phone){return [...screenChats.querySelectorAll('.chat-card')].find(el=>phone10(el.dataset.phone)===phone10(phone))||null}
    function bridgeToCard(parent,mode){
      clearTimeout(bridgeTimer);
      window.__medsiForcedEducatorParent=parent;
      root.classList.add('educator-new-chat-bridging');
      document.dispatchEvent(new Event('medsi:refresh-educator-chats'));
      const started=Date.now();
      const probe=()=>{
        if(disposed)return;
        const card=findChatCard(parent.phone);
        if(card){
          window.__medsiForcedEducatorParent=null;
          if(mode==='delete'){
            const control=card.querySelector('.chat-delete-toggle');
            if(control)control.click();
            showNew();
            root.classList.remove('educator-new-chat-bridging');
            if(deleteModal){
              const observer=new MutationObserver(()=>{
                if(deleteModal.classList.contains('hidden')){observer.disconnect();setTimeout(()=>{if(!disposed){rowsCache=null;renderedSignature='';showNew();loadParents()}},120)}
              });
              observer.observe(deleteModal,{attributes:true,attributeFilter:['class']});
            }
          }else{
            screen.classList.add('hidden');
            card.click();
            root.classList.remove('educator-new-chat-bridging');
          }
          return;
        }
        if(Date.now()-started>4500){
          window.__medsiForcedEducatorParent=null;root.classList.remove('educator-new-chat-bridging');showNew();
          error.textContent='Не удалось открыть чат родителя.';error.classList.remove('hidden');return;
        }
        bridgeTimer=setTimeout(probe,35);
      };
      bridgeTimer=setTimeout(probe,35);
    }

    btnNew.onclick=e=>{e&&e.preventDefault();showNew();loadParents()};
    back.onclick=e=>{e.preventDefault();showChats()};

    return()=>{
      disposed=true;clearTimeout(bridgeTimer);window.__medsiForcedEducatorParent=null;
      try{screen.remove()}catch(_){}
      if(typeof originalCleanup==='function')originalCleanup();
    };
  };
})();
