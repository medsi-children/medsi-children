(function(){
  const THREAD_LOAD_TIMEOUT_MS=8000;
  const REACTIONS=['❤️','👍','👌','🙏','🥰','😁','🔥'];
  const QUICK_REPLIES={
    meetings:`💌 Дорогие родители!\n\n⭐️ Обращаем ваше внимание, что договариваться о встрече с ребенком необходимо напрямую с вашим лечащим врачом!\n\n💬 Пожалуйста, напишите ему и подберите оптимальное время для встречи, с учетом состояния ребенка!\n\n🕐 Расписание встреч с 17:00 до 20:00.\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    meetTime:`💌 Дорогие родители!\n\n🕐 Время встреч с детьми:\n\nБУДНИ\n🌙 Вечер - 17:00 - 20:00\n\nВЫХОДНЫЕ\n☀️ Утро - 11:00 - 13:00\n🌙 Вечер - 17:00 - 20:00\n\n🙏 Просим приводить в указанное время, так как после встреч у детей начинается прием препаратов и терапия!\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    calls:`💌 Дорогие родители!\n\n⭐️ Обращаем ваше внимание, что договариваться о звонках ребенку необходимо напрямую с вашим лечащим врачом!\n\n💬 Пожалуйста, напишите ему и подберите оптимальное время для звонка, с учетом состояния ребенка!\n\n🕐 Расписание звонков с 17:00 до 20:00.\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    therapy:`💌 Дорогие родители!\n\n💊 Обращаем ваше внимание, что по вопросам лечения, процедур, препаратов и другим медицинским вопросам необходимо обращаться напрямую к лечащему врачу. Воспитатели и психологи не располагают такой информацией!\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    delivery:"🗺️ Адрес: Гринвуд, с11, Путилково\nДля курьера напишите «на 5 этаж» и имя ребёнка.\n\n✅ Что можно привезти или заказать:\nЛюбую еду и напитки в безопасной упаковке - пиццу, суши, сладости, фрукты, сок. Также можно передать одежду, книги, раскраски, творческие наборы, безопасную канцелярию.\n\n🚫 Что нельзя передавать:\nОстрые и колюще-режущие предметы (ножницы, лезвия, точилки), стекло, металлические банки, аэрозоли и столовые приборы. Также нельзя кофе, энергетики, табак, вейпы и личную электронику.\n\n💊 Лекарства — только после согласования с лечащим врачом.\n❓ Если сомневаетесь насчёт вещи, уточните у воспитателей.",
    routine:`💌 Дорогие родители!\n\n🕘 РЕЖИМ ДНЯ\n\n☀️ Утро\n\n8:00 — Подъём\n8:30 — Зарядка\n9:00 — Завтрак\n9:30 — Игры и творчество\n10:00 — Групповая психотерапия\n11:00 — Прогулка\n12:00 — Игры и творчество\n13:00 — Обед\n14:00 — Сон-час\n\n🌙 Вечер\n\n16:00 — Танцы\n16:30 — Полдник\n17:00 — Игры и творчество\n18:00 — Ужин\n18:15 — Киносеанс\n21:00 — Подготовка ко сну / \nМедицинские процедуры\n22:00 — Отбой\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    writeTopic:`💌 Дорогие родители!\n\n🗣️ Здесь можно задать вопрос, оставить пожелания по отчётам, получить просьбы ребёнка по доставке и согласовать звонки или онлайн-уроки.\n\n⭐ Вся информация по состоянию ребёнка входит в отчёт и обновляется два раза в день. Ответы на свои вопросы вы получите в составе следующего отчёта!\n\n💊 Все вопросы по медикаментам и терапии обсуждаются с вашим врачом!\n\n💬 Встречи и звонки также обсуждаются с лечащим врачом.\n\n‼️ У воспитателей и психологов нет возможности регулярно отвечать в чате, так как они работают с детьми.\n\n🔔 Расписание отчётов:\n\n☀️ Утро-день — до 16:00\n🌙 День-вечер — до 22:00\n🧠 Психотерапия — до 20:00\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    reportDelay:`💌 Дорогие родители!\n\nСегодня подготовка отчёта занимает немного больше времени, чем обычно. Пожалуйста, наберитесь терпения. Если в ближайшие часы отчёт не появится, напишите нам в чате.\n\n🩵 Спасибо за понимание!\nДетское Отделение Медси`,
    doctors:"Контакты врачей:\n\nАнастасия Михайловна\n+79253394090\nРабочие часы: с 9:00 до 18:00.\nВыходные дни: пятница и суббота.\n\nАнтон Геннадьевич\n+79859927884\nРабочие часы: с 9:00 до 18:00.\nВыходные дни: воскресенье и понедельник.\n\nПожалуйста, пишите и звоните врачам в рабочее время."
  };
  const threadCache=new Map();
  const phone10=v=>String(v||'').replace(/\D+/g,'').slice(-10);
  const displayPhone=v=>{const p=phone10(v);return p?'8'+p:''};
  const getCached=p=>threadCache.get(phone10(p))||null;
  const setCached=(p,rows)=>threadCache.set(phone10(p),{rows:Array.isArray(rows)?rows:[],at:Date.now()});

  function fmt(v){const d=new Date(Number(v));return Number.isNaN(d.getTime())?'':d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}
  function messageKey(m){const key=String(m&&m.messageKey||'').trim();return key||['fallback',m&&m.side||'',m&&m.timestamp||'',m&&m.type||'',m&&m.fileId||'',m&&m.text||''].join('|')}
  function messageSig(m){return JSON.stringify([m&&m.side||'',m&&m.type||'',m&&m.text||'',m&&m.fileId||'',m&&m.reaction||'',m&&m.editedAt||'',m&&m.timestamp||'',m&&m.replyToKey||'',m&&m.reply&&m.reply.messageKey||'',m&&m.reply&&m.reply.text||'',m&&m.readByParent,m&&m.readByParentAt,m&&m.parentRead,m&&m.parentReadAt,m&&m.read_by_parent,m&&m.parent_read_at])}
  function isPending(m){return String(m&&m.messageKey||'').startsWith('pending-')}
  function samePendingMessage(pending,confirmed){return isPending(pending)&&!isPending(confirmed)&&String(pending&&pending.side||'')===String(confirmed&&confirmed.side||'')&&String(pending&&pending.type||'')===String(confirmed&&confirmed.type||'')&&String(pending&&pending.text||'')===String(confirmed&&confirmed.text||'')&&String(pending&&pending.fileId||'')===String(confirmed&&confirmed.fileId||'')&&Math.abs(Number(pending&&pending.timestamp||0)-Number(confirmed&&confirmed.timestamp||0))<120000}
  function preview(c){if(!c)return'';if(c.lastType==='image')return c.lastText||'[Фотография]';if(c.lastType==='video')return c.lastText||'[Видео]';return c.lastText||'Нет сообщений'}
  function replyLabel(r){if(!r)return'';if(r.text)return String(r.text).slice(0,120);if(r.type==='image')return'Фотография';if(r.type==='video')return'Видео';return'Сообщение'}
  function mediaUrl(m){const id=String(m&&m.fileId||'');const transport=window.MedsiOverlayTransport;return id&&transport&&typeof transport.mediaUrl==='function'?transport.mediaUrl(id,'w1200'):''}

  function getEyeIconSvg(isRead){
    if(isRead){
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.6 12s3.4-6 9.4-6 9.4 6 9.4 6-3.4 6-9.4 6-9.4-6-9.4-6z"></path><circle cx="12" cy="12" r="2.7"></circle></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13.2c1.7 2.1 4.1 3.2 7 3.2s5.3-1.1 7-3.2"></path><path d="M7.2 15.2 5.8 17"></path><path d="M12 16.4v2.2"></path><path d="m16.8 15.2 1.4 1.8"></path></svg>';
  }
  function getPinIconSvg(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.72 5.5 6.07.88-4.4 4.28 1.04 6.04L12 16.84 6.57 19.7l1.04-6.04-4.4-4.28 6.07-.88L12 3"></path></svg>'}
  function getCloseIconSvg(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>'}
  function getDeleteIconSvg(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5V4h6v1"></path><path d="M4 7h16"></path><path d="M7 7v12c0 .6.4 1 1 1h8c.6 0 1-.4 1-1V7"></path><path d="M10 11v5"></path><path d="M14 11v5"></path></svg>'}

  function mount(overlay,state){
    const transport=window.MedsiOverlayTransport;
    const session=state&&state.session;
    if(!overlay||!transport||!session||!session.token){if(overlay)overlay.showError('Не удалось получить сессию воспитательского чата.');return}

    const oldScreen=document.body.dataset.screen||'';
    overlay.root.classList.add('educator-exact-clone');
    overlay.body.replaceChildren();

    const wrap=document.createElement('div');wrap.className='wrap';
    const frame=document.createElement('article');frame.className='frame';frame.id='frame';
    const rim=document.createElement('div');rim.id='rim';rim.className='rim';
    const scene=document.createElement('div');scene.className='scene';
    const title=document.createElement('h1');title.id='title';title.className='title';title.textContent='Чат с родителями';
    const meta=document.createElement('p');meta.id='meta';meta.className='meta';meta.textContent='Выберите чат с нужным родителем.';
    const screenChats=document.createElement('section');screenChats.id='screenChats';
    const chatList=document.createElement('div');chatList.id='chatList';chatList.className='chat-list';
    const chatListError=document.createElement('p');chatListError.id='chatListError';chatListError.className='error hidden';
    const listRow=document.createElement('div');listRow.className='row';listRow.style.marginTop='14px';
    const btnChatsBack=document.createElement('button');btnChatsBack.id='btnChatsBack';btnChatsBack.className='btn';btnChatsBack.textContent='Назад';
    const btnNewChat=document.createElement('button');btnNewChat.id='btnNewChat';btnNewChat.className='btn btn-teal';btnNewChat.textContent='Написать родителю';
    const btnRefreshChats=document.createElement('button');btnRefreshChats.id='btnRefreshChats';btnRefreshChats.className='btn refresh-btn';btnRefreshChats.title='Обновить список';btnRefreshChats.innerHTML='<span class="refresh-label" aria-hidden="true">⟳</span><span class="refresh-spinner" aria-hidden="true"></span>';
    listRow.append(btnChatsBack,btnNewChat,btnRefreshChats);screenChats.append(chatList,chatListError,listRow);

    const screenChatThread=document.createElement('section');screenChatThread.id='screenChatThread';screenChatThread.className='hidden';
    const chatThreadHeader=document.createElement('div');chatThreadHeader.id='chatThreadHeader';chatThreadHeader.className='chat-info';
    const chatThreadBox=document.createElement('div');chatThreadBox.id='chatThreadBox';chatThreadBox.className='chat-box';
    const chatThreadError=document.createElement('p');chatThreadError.id='chatThreadError';chatThreadError.className='error hidden';
    const chatReplyPreview=document.createElement('div');chatReplyPreview.id='chatReplyPreview';chatReplyPreview.className='chat-reply-preview hidden';chatReplyPreview.innerHTML='<div id="chatReplyPreviewTitle" class="chat-reply-preview-title"></div><div id="chatReplyPreviewText" class="chat-reply-preview-text"></div><button id="chatReplyCancel" type="button" class="chat-reply-cancel" aria-label="Отменить ответ">×</button>';
    const chatCompose=document.createElement('div');chatCompose.className='chat-compose';
    const fileInput=document.createElement('input');fileInput.id='chatImageInput';fileInput.type='file';fileInput.accept='image/*,video/*';fileInput.className='hidden';
    const attach=document.createElement('button');attach.id='chatAttachBtn';attach.type='button';attach.className='btn chat-attach-btn';attach.textContent='📎';
    const editorWrap=document.createElement('div');editorWrap.id='chatReplyEditor';editorWrap.className='chat-reply-editor';
    const editor=document.createElement('div');editor.id='chatReplyInput';editor.contentEditable='true';editor.setAttribute('role','textbox');editor.setAttribute('aria-multiline','true');editor.dataset.placeholder='Введите сообщение…';editorWrap.appendChild(editor);
    const send=document.createElement('button');send.id='chatReplySendBtn';send.type='button';send.className='btn btn-mint chat-send-btn';send.textContent='Отправить';
    chatCompose.append(fileInput,attach,editorWrap,send);
    const imagePreview=document.createElement('div');imagePreview.id='chatImagePreview';imagePreview.className='chat-image-preview hidden';imagePreview.innerHTML='<div class="preview-item"><img id="chatImagePreviewImg" src="" alt="Превью фото"><button id="chatImageRemoveBtn" class="preview-remove-btn" type="button" title="Удалить фото">✕</button></div>';
    const threadRow=document.createElement('div');threadRow.className='row';threadRow.style.marginTop='14px';
    const btnThreadBack=document.createElement('button');btnThreadBack.id='btnThreadBack';btnThreadBack.className='btn chat-nav-btn';btnThreadBack.textContent='Назад';
    const btnQuickReplies=document.createElement('button');btnQuickReplies.id='btnQuickReplies';btnQuickReplies.className='btn quick-toggle';btnQuickReplies.textContent='Быстрые ответы';
    const btnVideo=document.createElement('button');btnVideo.id='btnVideo';btnVideo.className='btn btn-sky chat-nav-btn';btnVideo.type='button';btnVideo.textContent='Видео';
    threadRow.append(btnThreadBack,btnQuickReplies,btnVideo);
    const quickPanel=document.createElement('div');quickPanel.id='quickRepliesPanel';quickPanel.className='quick-panel hidden';
    const quickGrid=document.createElement('div');quickGrid.className='quick-grid';
    const quickDefs=[['meetings','Встречи с детьми','quick-red'],['meetTime','Время встреч','quick-orange'],['calls','Звонки детям','quick-yellow'],['therapy','Терапия и препараты','quick-green'],['delivery','Доставка еды и вещей','quick-cyan'],['reportDelay','Задержка отчёта','quick-indigo'],['routine','Режим дня','quick-blue'],['writeTopic','Пишите по делу','quick-purple'],['doctors','Контакты врачей','quick-doctors']];
    quickDefs.forEach(([key,label,cls])=>{const b=document.createElement('button');b.type='button';b.className='quick-btn '+cls;b.textContent=label;b.onclick=()=>{editor.textContent=QUICK_REPLIES[key];quickPanel.classList.add('hidden');focusEditor()};quickGrid.appendChild(b)});
    quickPanel.appendChild(quickGrid);
    screenChatThread.append(chatThreadHeader,chatThreadBox,chatThreadError,chatReplyPreview,chatCompose,imagePreview,threadRow,quickPanel);

    scene.append(title,meta,screenChats,screenChatThread);frame.append(rim,scene);wrap.appendChild(frame);overlay.body.appendChild(wrap);
    if(window.MedsiChatListUI)window.MedsiChatListUI.install();

    const childDeleteModal=document.createElement('div');childDeleteModal.id='childDeleteModal';childDeleteModal.className='link-modal-overlay hidden';childDeleteModal.setAttribute('role','dialog');childDeleteModal.setAttribute('aria-modal','true');childDeleteModal.innerHTML='<div class="link-modal" style="border-color:rgba(244,63,94,.38);"><h3 class="link-modal-title" style="color:#b91c35;">Внимание!</h3><p id="childDeleteText" class="link-modal-text"></p><div class="link-modal-actions child-delete-actions"><button id="childDeleteCancel" class="link-modal-cancel" type="button">Отмена</button><button id="childDeleteConfirm" class="link-modal-save link-modal-delete" type="button">Удалить</button></div></div>';
    document.body.appendChild(childDeleteModal);

    let bucket='unread';
    let currentChats=[];
    let activeChat=null;
    let activeRows=[];
    let replyTo=null;
    let editing=null;
    let pendingFile=null;
    let pendingUrl='';
    let sending=false;
    let disposed=false;
    let deleteTarget=null;
    const deletionOperations=new Map();
    let threadRequestId=0;
    let chatsRequestId=0;
    let initialMessagesRendered=false;
    function showListScreen(){
      document.body.dataset.screen='screenChats';
      title.textContent='Чат с родителями';
      meta.textContent=bucket==='read'?'Прочитанные чаты':'Выберите чат с нужным родителем.';
      screenChats.classList.remove('hidden');
      // Navigation must remain usable while the list request is pending.
      screenChats.classList.add('overlay-screen-ready');
      screenChatThread.classList.add('hidden');
    }
    function showThreadScreen(){document.body.dataset.screen='screenChatThread';screenChats.classList.add('hidden');screenChatThread.classList.remove('hidden')}
    function setRefresh(v){btnRefreshChats.classList.toggle('loading',!!v);btnRefreshChats.disabled=!!v}

    function makeReadToggle(chat,isRead){
      const toggle=document.createElement('span');toggle.className='chat-read-toggle';toggle.setAttribute('role','button');toggle.setAttribute('tabindex','0');
      const setState=value=>{toggle.classList.toggle('is-read',!!value);toggle.classList.toggle('is-unread',!value);toggle.innerHTML=getEyeIconSvg(!!value);toggle.title=value?'Пометить непрочитанным':'Пометить прочитанным'};
      setState(isRead);
      const activate=async event=>{
        event.preventDefault();event.stopPropagation();
        if(toggle.classList.contains('is-busy'))return;
        toggle.classList.add('is-busy');
        try{
          if(isRead){await transport.markUnread(session,chat.phone)}
          else{await transport.markRead(session,'educator',chat.phone)}
          await loadChats(false);
        }catch(err){overlay.showError(err.message)}finally{toggle.classList.remove('is-busy')}
      };
      toggle.onclick=activate;toggle.onkeydown=e=>{if(e.key==='Enter'||e.key===' ')activate(e)};
      return toggle;
    }
    function makePinToggle(chat,primary){
      const isPinned=chat&&chat.pinnedBucket===bucket;
      const toggle=document.createElement('button');toggle.type='button';toggle.className='chat-pin-toggle'+(isPinned?' is-pinned':'')+(primary?' chat-primary-toggle':'');toggle.innerHTML=getPinIconSvg();toggle.title=isPinned?'Открепить':'Закрепить сверху';
      toggle.onclick=async event=>{
        event.preventDefault();event.stopPropagation();
        try{await transport.pin(session,chat.phone,isPinned?'':bucket);await loadChats(false)}catch(err){overlay.showError(err.message)}
      };
      return toggle;
    }
    function requestChildDeletion(chat){deleteTarget=chat;childDeleteModal.querySelector('#childDeleteText').textContent='Вы хотите удалить ребёнка '+(chat.childName||'Без имени ребёнка')+'. Вся история сообщений будет удалена!';childDeleteModal.classList.remove('hidden')}
    function makeDeleteToggle(chat){const toggle=document.createElement('span');toggle.className='chat-delete-toggle';toggle.setAttribute('role','button');toggle.setAttribute('tabindex','0');toggle.title='Удалить ребёнка';toggle.innerHTML=getDeleteIconSvg();toggle.onclick=e=>{e.preventDefault();e.stopPropagation();requestChildDeletion(chat)};return toggle}
    function closeControls(controls){clearTimeout(controls._menuCloseTimer);controls.classList.remove('is-menu-open');controls.closest('.chat-card')?.classList.remove('chat-controls-expanded');const menuToggle=controls.querySelector('.chat-menu-toggle');if(menuToggle){menuToggle.setAttribute('aria-expanded','false');menuToggle.setAttribute('aria-label','Показать действия чата')}}
    function makeMenuToggle(controls){const toggle=document.createElement('button');toggle.type='button';toggle.className='chat-menu-toggle';toggle.setAttribute('aria-label','Показать действия чата');toggle.setAttribute('aria-expanded','false');toggle.title='Действия чата';toggle.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';toggle.onclick=e=>{e.preventDefault();e.stopPropagation();if(controls.classList.contains('is-menu-open')){closeControls(controls);return}openControls(controls)};return toggle}
    function makeCloseToggle(controls){const toggle=document.createElement('button');toggle.type='button';toggle.className='chat-menu-close';toggle.setAttribute('aria-label','Закрыть меню действий');toggle.title='Закрыть меню';toggle.innerHTML=getCloseIconSvg();toggle.onclick=e=>{e.preventDefault();e.stopPropagation();closeControls(controls);};return toggle}
    function openControls(controls){controls.classList.add('is-menu-open');controls.closest('.chat-card')?.classList.add('chat-controls-expanded');const menuToggle=controls.querySelector('.chat-menu-toggle');if(menuToggle){menuToggle.setAttribute('aria-expanded','true');menuToggle.setAttribute('aria-label','Скрыть действия чата')}clearTimeout(controls._menuCloseTimer);controls._menuCloseTimer=setTimeout(()=>closeControls(controls),5000)}
    function resetControlsTimer(controls){if(controls.classList.contains('is-menu-open'))openControls(controls)}
    function makeControls(chat,isRead){
      const controls=document.createElement('div');controls.className='chat-controls';
      const menu=document.createElement('div');menu.className='chat-controls-menu';
      const pinned=chat&&chat.pinnedBucket===bucket;
      menu.appendChild(makeCloseToggle(controls));
      if(pinned){menu.append(makeReadToggle(chat,isRead),makeDeleteToggle(chat),makePinToggle(chat,true))}
      else{menu.append(makeReadToggle(chat,isRead),makeDeleteToggle(chat),makePinToggle(chat,false))}
      controls.append(makeMenuToggle(controls),menu);
      controls.addEventListener('mouseleave',()=>{if(matchMedia('(hover: hover)').matches&&controls.classList.contains('is-menu-open'))closeControls(controls)});
      ['pointerdown','pointermove','touchstart','focusin'].forEach(type=>controls.addEventListener(type,()=>resetControlsTimer(controls),{passive:true}));
      return controls;
    }
    function makeCard(chat){
      const card=document.createElement('button');card.className='chat-card'+(chat.hasUnread?' unread':'')+(chat.pinnedBucket?' pinned':'');card.type='button';card.dataset.phone=chat.phone||'';
      const cardTitle=document.createElement('div');cardTitle.className='chat-card-title';cardTitle.textContent=chat.childName||'Без имени ребёнка';
      const cardMeta=document.createElement('div');cardMeta.className='chat-card-meta';cardMeta.textContent=(chat.relationship||'Родитель')+': '+(chat.parentName||'—')+'\nРебёнок: '+(chat.childName||'—')+'\nНомер телефона: '+(chat.phone?displayPhone(chat.phone):'—');
      const last=document.createElement('div');last.className='chat-card-last '+(chat.lastSide==='educator'?'educator':'parent');last.textContent=preview(chat);
      card.append(makeControls(chat,!chat.hasUnread),cardTitle,cardMeta,last);
      card.onclick=e=>{if(e.target.closest('.chat-menu-toggle,.chat-menu-close,.chat-read-toggle,.chat-delete-toggle,.chat-pin-toggle'))return;activeChat=chat;openThread(chat)};
      return card;
    }
    function renderList(){
      chatList.replaceChildren();
      if(bucket==='read'){
        const w=document.createElement('div');w.style.cssText='text-align:center; margin-bottom:12px; padding:12px;';
        const b=document.createElement('button');b.className='btn';b.style.cssText='width:100%; max-width:100%;';b.textContent='← Вернуться к непрочитанным';b.onclick=()=>{bucket='unread';loadChats(false)};w.appendChild(b);chatList.appendChild(w);
      }
      if(!currentChats.length){const e=document.createElement('div');e.className='chat-empty';e.textContent=bucket==='read'?'Прочитанных чатов нет.':'Новых сообщений нет.';chatList.appendChild(e)}
      currentChats.forEach(c=>chatList.appendChild(makeCard(c)));
      if(bucket==='unread'){
        const w=document.createElement('div');w.style.cssText='text-align:center; margin-top:20px; padding:16px; border-top:1px solid rgba(36,211,218,0.18);';
        const b=document.createElement('button');b.className='btn';b.style.cssText='width:100%; max-width:100%;';b.textContent='Открыть прочитанные чаты';b.onclick=()=>{bucket='read';loadChats(false)};w.appendChild(b);chatList.appendChild(w);
      }
    }
    function removeDeletedChat(chat){
      const targetPhone=phone10(chat&&chat.phone);if(!targetPhone)return;
      currentChats=currentChats.filter(item=>phone10(item&&item.phone)!==targetPhone);threadCache.delete(targetPhone);
      const card=[...chatList.querySelectorAll('.chat-card')].find(item=>phone10(item.dataset.phone)===targetPhone);
      if(!card){renderList();return}
      card.classList.add('medsi-chat-card-deleting');
      setTimeout(()=>{if(!disposed&&document.body.dataset.screen==='screenChats')renderList()},220);
    }
    async function loadChats(spinner){
      const requestId=++chatsRequestId;
      showListScreen();if(spinner)setRefresh(true);
      if(!chatList.childElementCount)chatList.innerHTML='<div class="chat-empty">Загрузка...</div>';
      try{
        const res=await transport.chats(session,bucket,{fresh:true});
        if(disposed||requestId!==chatsRequestId)return;
        currentChats=(res&&res.chats||[]).slice().sort((a,b)=>Number(b&&b.pinnedBucket===bucket)-Number(a&&a.pinnedBucket===bucket));
        renderList();
        overlay.clearError();
      }catch(err){
        if(!disposed&&requestId===chatsRequestId){
          if(!currentChats.length){
            const state=document.createElement('div');state.className='chat-empty';
            const label=document.createElement('p');label.textContent='Не удалось получить список чатов.';
            const retry=document.createElement('button');retry.type='button';retry.className='btn';retry.textContent='Повторить';retry.onclick=()=>loadChats(true);
            state.append(label,retry);chatList.replaceChildren(state);
          }
          overlay.showError(err.message||'Не удалось получить список чатов.');
        }
      }finally{if(requestId===chatsRequestId)setRefresh(false)}
    }
    const refreshChats=()=>loadChats(true);
    document.addEventListener('medsi:refresh-educator-chats',refreshChats);

    function renderThreadHeader(chat){chatThreadHeader.replaceChildren();[(chat.relationship||'Родитель')+': '+(chat.parentName||'—'),'Ребёнок: '+(chat.childName||'—'),'Номер телефона: '+displayPhone(chat.phone||'')].forEach(text=>{const d=document.createElement('div');d.textContent=text;chatThreadHeader.appendChild(d)})}
    function threadWithTimeout(phone){
      return new Promise((resolve,reject)=>{
        let settled=false;
        const timer=setTimeout(()=>{if(settled)return;settled=true;const error=new Error('Сервер чата отвечает слишком долго.');error.code='THREAD-TIMEOUT';reject(error)},THREAD_LOAD_TIMEOUT_MS);
        Promise.resolve(transport.thread(session,phone,'',100)).then(
          value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value)},
          error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)}
        );
      });
    }
    function showThreadLoadFailure(){
      if(activeRows.length)return;
      const state=document.createElement('div');state.className='chat-empty';state.dataset.state='error';
      const message=document.createElement('div');message.textContent='Не удалось получить сообщения.';
      const retry=document.createElement('button');retry.type='button';retry.className='btn';retry.textContent='Повторить';retry.style.cssText='display:block;width:auto;min-width:140px;margin:12px auto 0;padding:10px 18px;';
      retry.onclick=()=>{retry.disabled=true;message.textContent='Повторяем запрос…';refreshThread(false)};
      state.append(message,retry);chatThreadBox.replaceChildren(state);
    }
    function messageNode(m,quiet){
      const el=document.createElement('div');el.className='msg '+(m.side==='educator'?'educator':'parent');el.dataset.medsiMessageKey=messageKey(m);el.dataset.medsiMessageSignature=messageSig(m);if(quiet)el.dataset.medsiAnimated='1';
      const author=document.createElement('div');author.className='msg-author';
      author.textContent=m.side==='parent'
        ?(activeChat&&activeChat.relationship||'Родитель')+(activeChat&&activeChat.parentName?' '+activeChat.parentName:'')
        :'Детское Отделение Медси';
      el.appendChild(author);
      if(m.reply){const q=document.createElement('div');q.className='msg-reply-quote';q.textContent=replyLabel(m.reply);el.appendChild(q)}
      const url=mediaUrl(m),previewUrl=m.type==='image'&&window.MedsiOverlayTransport&&typeof window.MedsiOverlayTransport.mediaPreviewUrl==='function'?window.MedsiOverlayTransport.mediaPreviewUrl(m.fileId,'w960'):url;if(url){const wrap=document.createElement('div');wrap.className='msg-image-wrap';const media=document.createElement(m.type==='video'?'video':'img');const markReady=()=>{wrap.classList.add('loaded','medsi-media-ready');if(m.type==='image'&&window.MedsiMediaPreload)window.MedsiMediaPreload.queueOriginal(url)};media.addEventListener('load',markReady,{once:true});media.addEventListener('loadedmetadata',markReady,{once:true});media.addEventListener('error',()=>wrap.classList.add('medsi-media-error'),{once:true});if(m.type==='video'){media.controls=true;media.preload='metadata'}wrap.appendChild(media);el.appendChild(wrap);media.src=previewUrl;if((media.tagName==='IMG'&&media.complete&&media.naturalWidth>0)||(media.tagName==='VIDEO'&&media.readyState>=1))markReady()}
      if(m.text){const body=document.createElement('div');body.className='msg-body';body.textContent=String(m.text);el.appendChild(body)}
      if(m.reaction){const r=document.createElement('span');r.className='msg-reaction';r.textContent=m.reaction;el.appendChild(r)}
      const time=document.createElement('span');time.className='msg-time';time.textContent=[fmt(m.timestamp),m.editedAt?'изм.':''].filter(Boolean).join(' · ');el.appendChild(time);
      const openContext=e=>openMessageMenu(m,el,e);el.onclick=openContext;el.oncontextmenu=openContext;el.addEventListener('medsi:message-longpress',openContext);return el;
    }
    function renderRows(nextRows,stick=true,opts){
      const previousRows=activeRows,updatedRows=Array.isArray(nextRows)?nextRows:[],oldTop=chatThreadBox.scrollTop;
      const animateInitial=!!(opts&&opts.animateInitial)&&!initialMessagesRendered;
      if(!updatedRows.length){
        activeRows=[];
        initialMessagesRendered=true;
        const existingEmpty=chatThreadBox.querySelector(':scope > .chat-empty');
        if(existingEmpty&&existingEmpty.dataset.state==='empty')return;
        const empty=document.createElement('div');empty.className='chat-empty';empty.dataset.state='empty';empty.textContent='Сообщений пока нет.';chatThreadBox.replaceChildren(empty);return
      }
      const existing=new Map([...chatThreadBox.children].filter(el=>el.matches&&el.matches('.msg')&&el.dataset.medsiMessageKey).map(el=>[el.dataset.medsiMessageKey,el]));
      const hadMessages=existing.size>0,hasStableOverlap=updatedRows.some(m=>existing.has(messageKey(m))),quietAllNew=hadMessages&&!hasStableOverlap;
      const existingOrder=[...chatThreadBox.children].filter(el=>el.matches&&el.matches('.msg')).map(el=>el.dataset.medsiMessageKey||'');
      const sameOrder=existingOrder.length===updatedRows.length&&updatedRows.every((m,index)=>existingOrder[index]===messageKey(m));
      if(sameOrder){
        updatedRows.forEach(m=>{const old=existing.get(messageKey(m));if(old&&old.dataset.medsiMessageSignature!==messageSig(m))old.replaceWith(messageNode(m,true))});
        activeRows=updatedRows;
        return;
      }
      const pendingRows=previousRows.filter(isPending),usedPending=new Set();
      const nodes=updatedRows.map((m,index)=>{const key=messageKey(m),sig=messageSig(m),old=existing.get(key);if(old&&old.dataset.medsiMessageSignature===sig)return old;if(old)return messageNode(m,true);const pending=pendingRows.find(row=>!usedPending.has(messageKey(row))&&samePendingMessage(row,m));if(pending)usedPending.add(messageKey(pending));const quiet=!animateInitial||quietAllNew||!!pending||(!hadMessages&&index<updatedRows.length-14);return messageNode(m,quiet)});
      activeRows=updatedRows;
      initialMessagesRendered=true;
      const fragment=document.createDocumentFragment();nodes.forEach(node=>fragment.appendChild(node));chatThreadBox.replaceChildren(fragment)
      requestAnimationFrame(()=>{if(stick)chatThreadBox.scrollTo({top:chatThreadBox.scrollHeight,behavior:'auto'});else if(opts&&opts.preserveExact)chatThreadBox.scrollTop=Math.max(0,oldTop)})
    }
    async function refreshThread(preserve){
      if(!activeChat)return;
      const targetPhone=phone10(activeChat.phone);
      const requestId=++threadRequestId;
      const gap=chatThreadBox.scrollHeight-chatThreadBox.scrollTop-chatThreadBox.clientHeight;
      try{
        const res=await threadWithTimeout(targetPhone);
        if(disposed)return;
        if(requestId!==threadRequestId||!activeChat||phone10(activeChat.phone)!==targetPhone)return;
      const receivedRows=Array.isArray(res&&res.messages)?res.messages:[];
      const pendingRows=activeRows.filter(isPending).filter(pending=>!receivedRows.some(row=>samePendingMessage(pending,row)));
      const nextRows=receivedRows.concat(pendingRows);
        setCached(targetPhone,nextRows);
        renderRows(nextRows,!preserve||gap<80,{preserveExact:preserve&&gap>80,animateInitial:!initialMessagesRendered});
      }catch(err){
        if(requestId===threadRequestId&&activeChat&&phone10(activeChat.phone)===targetPhone){showThreadLoadFailure();overlay.showError(err.message||'Не удалось загрузить чат.')}
      }
    }
    async function openThread(chat){
      threadRequestId++;
      setReply(null);editing=null;clearFile();editor.textContent='';
      activeRows=[];
      initialMessagesRendered=false;
      activeChat=chat;
      if(window.MedsiMediaPreload)window.MedsiMediaPreload.reset();
      showThreadScreen();renderThreadHeader(chat);
      const cached=getCached(chat.phone);
      if(cached){chatThreadBox.replaceChildren();renderRows(cached.rows,true,{animateInitial:true});}
      else{
        const connecting=document.createElement('div');connecting.className='chat-empty';connecting.dataset.state='connecting';connecting.textContent='Подключаемся к чату…';chatThreadBox.replaceChildren(connecting);
      }
      await refreshThread(false);
      if(!activeChat||phone10(activeChat.phone)!==phone10(chat.phone))return;
      transport.markRead(session,'educator',chat.phone).catch(()=>{});chat.hasUnread=false
    }
    function applyLiveRows(phone,nextRows){
      if(disposed||!activeChat||phone10(activeChat.phone)!==phone10(phone))return false;
      const stick=chatThreadBox.scrollHeight-chatThreadBox.scrollTop-chatThreadBox.clientHeight<90;
      setCached(phone,nextRows);renderRows(nextRows,stick,{preserveExact:!stick});
      transport.markRead(session,'educator',phone).catch(()=>{});activeChat.hasUnread=false;return true
    }
    window.__medsiEducatorApplyThreadRefresh=applyLiveRows;

    const contextMenu=document.createElement('div');contextMenu.id='chatContextMenu';contextMenu.className='chat-context-menu hidden';contextMenu.innerHTML='<div class="chat-context-reactions"></div><div class="chat-context-actions"></div>';document.body.appendChild(contextMenu);
    function closeMessageMenu(){contextMenu.classList.add('hidden');contextMenu.querySelector('.chat-context-reactions').replaceChildren();contextMenu.querySelector('.chat-context-actions').replaceChildren()}
    function contextAction(icon,label,fn,danger){const b=document.createElement('button');b.type='button';b.className='chat-context-action'+(danger?' danger':'');b.innerHTML='<span class="chat-context-action-icon">'+icon+'</span><span></span>';b.lastChild.textContent=label;b.onclick=()=>{closeMessageMenu();fn()};return b}
    function editorText(){return String(editor.innerText||editor.textContent||'').replace(/\r\n?/g,'\n').trim()}
    function focusEditor(){
      if(disposed||!activeChat||sending||document.body.dataset.screen!=='screenChatThread'||screenChatThread.classList.contains('hidden')||!editor.isConnected)return;
      requestAnimationFrame(()=>{
        if(disposed||!activeChat||sending||document.body.dataset.screen!=='screenChatThread'||screenChatThread.classList.contains('hidden')||!editor.isConnected)return;
        try{editor.focus({preventScroll:true})}catch(_){editor.focus()}
      });
    }
    function setReply(m){replyTo=m||null;chatReplyPreview.classList.toggle('hidden',!replyTo);chatReplyPreview.querySelector('#chatReplyPreviewTitle').textContent=replyTo?'Ответ на сообщение':'';chatReplyPreview.querySelector('#chatReplyPreviewText').textContent=replyTo?replyLabel(replyTo):'';if(replyTo){editing=null;focusEditor()}}
    function setEdit(m){editing=m||null;if(editing){replyTo=null;chatReplyPreview.classList.add('hidden');editor.textContent=String(editing.text||'');focusEditor()}}
    function openMessageMenu(m,el,e){
      if(!m||!m.messageKey||String(m.messageKey).startsWith('pending-'))return;e.preventDefault();e.stopPropagation();closeMessageMenu();
      const rs=contextMenu.querySelector('.chat-context-reactions');REACTIONS.forEach(r=>{const b=document.createElement('button');b.className='msg-reaction-btn';b.type='button';b.textContent=r;b.onclick=async()=>{closeMessageMenu();try{await transport.react(session,m.messageKey,r);refreshThread(true)}catch(err){overlay.showError(err.message)}};rs.appendChild(b)});
      const acts=contextMenu.querySelector('.chat-context-actions');acts.appendChild(contextAction('↩','Ответить',()=>setReply(m)));if(m.side==='educator'&&['text','image','video'].includes(m.type))acts.appendChild(contextAction('✎','Редактировать',()=>setEdit(m)));if(m.side==='educator'||m.side==='parent')acts.appendChild(contextAction('⌫','Удалить',async()=>{if(!confirm('Удалить это сообщение?'))return;try{await transport.remove(session,'educator',m.messageKey);refreshThread(false)}catch(err){overlay.showError(err.message)}},true));
      contextMenu.classList.remove('hidden');const r=el.getBoundingClientRect(),w=310;contextMenu.style.left=Math.min(innerWidth-w-12,Math.max(12,r.left+(r.width-w)/2))+'px';let top=r.bottom+8;if(top+220>innerHeight)top=Math.max(12,r.top-220);contextMenu.style.top=top+'px';
    }

    function clearFile(){pendingFile=null;imagePreview.classList.add('hidden');if(pendingUrl){URL.revokeObjectURL(pendingUrl);pendingUrl=''}imagePreview.querySelector('img').removeAttribute('src')}
    function setSending(v){sending=!!v;send.disabled=sending;attach.disabled=sending;editor.contentEditable=sending?'false':'true'}
    async function submit(){
      if(!activeChat||sending)return;const value=transport.normalizeEducatorText(editorText());if(!value&&!pendingFile)return;setSending(true);
      const targetChat=activeChat;
      const targetPhone=phone10(targetChat.phone);
      const targetFile=pendingFile;
      const targetReply=replyTo;
      const targetEditing=editing;
      try{
        if(targetEditing){
          await transport.edit(session,'educator',targetEditing.messageKey,value);
          if(activeChat===targetChat){editing=null;editor.textContent='';await refreshThread(false)}
        }
        else if(targetFile){
          const up=await transport.upload(session,targetPhone,targetFile);
          await transport.sendMessage(session,'educator',targetPhone,{type:up.type||(targetFile.type.startsWith('video/')?'video':'image'),text:value,fileId:up.fileId,replyToKey:targetReply&&targetReply.messageKey||''});
          if(activeChat===targetChat){editor.textContent='';setReply(null);clearFile();await refreshThread(false)}
        }
        else{
          const optimistic={side:'educator',type:'text',text:value,timestamp:Date.now(),messageKey:'pending-'+Date.now().toString(36)};
          renderRows(activeRows.concat(optimistic));editor.textContent='';
          await transport.sendMessage(session,'educator',targetPhone,{type:'text',text:value,replyToKey:targetReply&&targetReply.messageKey||''});
          if(activeChat===targetChat){setReply(null);setSending(false);refreshThread(false)}
          return
        }
      }catch(err){overlay.showError(err.message||'Не удалось отправить сообщение.')}finally{setSending(false);focusEditor()}
    }

    btnChatsBack.onclick=()=>overlay.close();
    btnNewChat.onclick=()=>overlay.showError('Экран выбора нового родителя перенесём следующим блоком из оригинала.');
    btnRefreshChats.onclick=()=>loadChats(true);
    btnThreadBack.onclick=()=>{threadRequestId++;activeChat=null;setReply(null);editing=null;clearFile();editor.textContent='';bucket='unread';loadChats(false)};
    btnQuickReplies.onclick=()=>quickPanel.classList.toggle('hidden');
    btnVideo.onclick=()=>fileInput.click();
    attach.onclick=()=>fileInput.click();
    send.onclick=submit;
    fileInput.onchange=()=>{const f=fileInput.files&&fileInput.files[0];fileInput.value='';if(!f)return;const maxBytes=Number(transport.maxUploadBytes||100*1024*1024);if(f.size>maxBytes){overlay.showError('Размер файла не должен превышать 100 МБ.');return}clearFile();pendingFile=f;pendingUrl=URL.createObjectURL(f);imagePreview.querySelector('img').src=pendingUrl;imagePreview.classList.remove('hidden')};
    imagePreview.querySelector('#chatImageRemoveBtn').onclick=clearFile;
    chatReplyPreview.querySelector('#chatReplyCancel').onclick=()=>setReply(null);
    childDeleteModal.querySelector('#childDeleteCancel').onclick=()=>{deleteTarget=null;childDeleteModal.classList.add('hidden')};
    async function confirmChildDeletion(){
      const confirmButton=childDeleteModal.querySelector('#childDeleteConfirm');
      const cancelButton=childDeleteModal.querySelector('#childDeleteCancel');
      if(!deleteTarget||confirmButton.disabled)return;
      const target=deleteTarget;
      const targetPhone=phone10(target.phone);
      if(!deletionOperations.has(targetPhone))deletionOperations.set(targetPhone,'delete_'+crypto.randomUUID().replace(/-/g,''));
      confirmButton.disabled=true;cancelButton.disabled=true;
      try{
        if(typeof transport.parentDelete!=='function')throw new Error('Не загрузилось быстрое удаление. Обновите страницу и попробуйте ещё раз.');
        const auth=window.MedsiTutorAdmin&&typeof window.MedsiTutorAdmin.session==='function'
          ?await window.MedsiTutorAdmin.session():session;
        const result=await transport.parentDelete(auth,{phone:target.phone,operationId:deletionOperations.get(targetPhone)});
        if(!result||result.ok!==true||result.accepted!==true)throw new Error(result&&result.message||'Не удалось подтвердить удаление.');
        deletionOperations.delete(targetPhone);
        deleteTarget=null;childDeleteModal.classList.add('hidden');removeDeletedChat(target);
        window.MedsiEducatorPrewarm?.clear();
      }catch(err){overlay.showError(err.message)}
      finally{confirmButton.disabled=false;cancelButton.disabled=false}
    }
    childDeleteModal.querySelector('#childDeleteConfirm').onclick=confirmChildDeletion;
    childDeleteModal.onclick=e=>{if(e.target===childDeleteModal&&!childDeleteModal.querySelector('#childDeleteConfirm').disabled){deleteTarget=null;childDeleteModal.classList.add('hidden')}};
    document.addEventListener('click',closeMessageMenu);

    loadChats(false);
    return()=>{
      disposed=true;
      document.removeEventListener('medsi:refresh-educator-chats',refreshChats);
      if(window.__medsiEducatorApplyThreadRefresh===applyLiveRows)delete window.__medsiEducatorApplyThreadRefresh;
      if(pendingUrl)URL.revokeObjectURL(pendingUrl);
      contextMenu.remove();childDeleteModal.remove();
      overlay.root.classList.remove('educator-exact-clone');
      if(oldScreen)document.body.dataset.screen=oldScreen;else delete document.body.dataset.screen;
    };
  }

  window.MedsiEducatorOverlayChat={mount};
})();
