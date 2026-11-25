(function(){
  'use strict';
  const PREFIX='gallery:';
  const FILE=/^s3:chat\/[A-Za-z0-9._-]{8,180}$/;
  const valid=items=>Array.isArray(items)&&items.length>=2&&items.length<=10&&
    items.every(item=>item&&FILE.test(String(item.fileId||''))&&
      ['image','video'].includes(item.type))&&
    new Set(items.map(item=>item.fileId)).size===items.length;
  function parse(input){
    const raw=String(input||'');
    if(!raw.startsWith(PREFIX)||raw.length>2400)return null;
    try{
      const list=JSON.parse(raw.slice(PREFIX.length));
      return valid(list)?list:null;
    }catch(_){return null}
  }
  function pack(items){
    const encoded=PREFIX+JSON.stringify(items);
    if(!parse(encoded))throw new Error('Для медиагруппы выберите от 2 до 10 файлов.');
    return encoded;
  }
  function open(items,selected,transport){
    let index=selected;
    const dialog=document.createElement('div');dialog.className='medsi-gallery-lightbox';
    dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
    dialog.setAttribute('aria-label','Просмотр вложений');
    const panel=document.createElement('div');panel.className='medsi-gallery-lightbox-panel';
    const picture=document.createElement('div');picture.className='medsi-gallery-lightbox-media';
    const close=document.createElement('button');close.type='button';close.className='medsi-gallery-lightbox-close';
    close.textContent='×';close.setAttribute('aria-label','Закрыть');
    const before=document.createElement('button');before.type='button';before.className='medsi-gallery-arrow';
    before.textContent='‹';before.setAttribute('aria-label','Предыдущее вложение');
    const after=document.createElement('button');after.type='button';after.className='medsi-gallery-arrow';
    after.textContent='›';after.setAttribute('aria-label','Следующее вложение');
    const counter=document.createElement('div');counter.className='medsi-gallery-counter';
    const remove=()=>{dialog.remove();document.removeEventListener('keydown',keyDown)};
    const show=()=>{
      picture.replaceChildren();
      const item=items[index];const url=transport.mediaUrl(item.fileId);
      const medium=document.createElement(item.type==='video'?'video':'img');
      if(item.type==='video'){medium.controls=true;medium.preload='metadata';medium.playsInline=true}
      else medium.alt='Фотография '+(index+1)+' из '+items.length;
      const status=document.createElement('button');status.type='button';
      status.className='medsi-gallery-load-status';
      const setLoading=()=>{
        status.disabled=true;status.classList.remove('is-error');status.replaceChildren();
        const spinner=document.createElement('span');spinner.className='medsi-gallery-spinner';
        spinner.setAttribute('aria-hidden','true');status.append(spinner);
        status.setAttribute('aria-label','Загрузка вложения');
      };
      const setError=()=>{
        status.disabled=false;status.classList.add('is-error');
        status.textContent='Не удалось загрузить. Повторить';
        status.setAttribute('aria-label','Не удалось загрузить вложение. Повторить');
      };
      setLoading();
      let thumbnail=null;
      if(item.type==='image'&&typeof transport.mediaPreviewUrl==='function'){
        thumbnail=document.createElement('img');thumbnail.alt=medium.alt;
        thumbnail.src=transport.mediaPreviewUrl(item.fileId);
        picture.append(thumbnail);
        medium.style.display='none';medium.fetchPriority='high';
      }
      picture.append(medium,status);
      const loaded=()=>{thumbnail?.remove();medium.style.display='';status.remove();};
      medium.onload=loaded;medium.onloadeddata=loaded;
      medium.onerror=setError;
      status.onclick=()=>{setLoading();medium.src=url;};
      medium.src=url;
      counter.textContent=(index+1)+' / '+items.length;
      before.disabled=index===0;after.disabled=index===items.length-1;
    };
    const step=delta=>{index=Math.max(0,Math.min(items.length-1,index+delta));show()};
    const keyDown=event=>{
      if(event.key==='Escape')remove();
      if(event.key==='ArrowLeft')step(-1);
      if(event.key==='ArrowRight')step(1);
    };
    close.onclick=remove;before.onclick=()=>step(-1);after.onclick=()=>step(1);
    dialog.onclick=event=>{if(event.target===dialog)remove()};
    let firstX=null;
    dialog.addEventListener('touchstart',event=>{
      firstX=event.changedTouches[0]?.clientX??null;
    },{passive:true});
    dialog.addEventListener('touchend',event=>{
      if(firstX===null)return;
      const distance=(event.changedTouches[0]?.clientX??firstX)-firstX;
      firstX=null;
      if(Math.abs(distance)>45)step(distance<0?1:-1);
    },{passive:true});
    panel.append(close,before,picture,after,counter);dialog.append(panel);
    document.body.append(dialog);document.addEventListener('keydown',keyDown);
    show();close.focus();
  }
  function render(raw,transport){
    const items=parse(raw);
    if(!items||!transport||typeof transport.mediaUrl!=='function')return null;
    const root=document.createElement('div');root.className='medsi-gallery-grid';
    root.setAttribute('aria-label',items.length+' вложений');
    items.forEach((item,index)=>{
      const btn=document.createElement('button');btn.type='button';btn.className='medsi-gallery-tile';
      btn.setAttribute('aria-label','Посмотреть вложение '+(index+1)+' из '+items.length);
      const media=document.createElement(item.type==='video'?'video':'img');
      if(item.type==='video'){media.preload='none';media.muted=true;media.playsInline=true}
      else {media.alt='';media.loading='lazy';media.decoding='async';}
      let attempts=0;
      const note=document.createElement('span');note.className='medsi-gallery-tile-status';
      note.setAttribute('role','status');
      const tileLoading=()=>{
        note.classList.remove('is-error','is-video');note.replaceChildren();
        const spinner=document.createElement('span');spinner.className='medsi-gallery-spinner';
        spinner.setAttribute('aria-hidden','true');note.append(spinner);
        note.setAttribute('aria-label','Загрузка вложения');
      };
      const tileError=()=>{
        note.classList.add('is-error');note.textContent='Открыть фото';
        note.setAttribute('aria-label','Не удалось загрузить. Откройте фото для повтора');
      };
      if(item.type==='image'){tileLoading();btn.append(note);}
      media.onload=()=>{if(item.type==='image')note.remove();};
      media.onerror=()=>{
        if(attempts++<1){setTimeout(()=>{media.src=previewUrl;},700);return;}
        tileError();
      };
      const previewUrl=item.type==='image'&&typeof transport.mediaPreviewUrl==='function'
        ?transport.mediaPreviewUrl(item.fileId):transport.mediaUrl(item.fileId);
      media.src=previewUrl;
      if(item.type==='video'){
        note.classList.add('is-video');note.textContent='Видео';
        note.setAttribute('aria-label','Видео');btn.append(note);
      }
      btn.append(media);
      if(item.type==='video'){const symbol=document.createElement('span');symbol.className='medsi-gallery-play';symbol.textContent='▶';btn.append(symbol)}
      btn.addEventListener('click',event=>{event.stopPropagation();event.preventDefault();open(items,index,transport)});
      root.append(btn);
    });
    return root;
  }
  window.MedsiChatGallery={parse,pack,render};
})();
