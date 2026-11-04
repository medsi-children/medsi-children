(function(){
  if(window.MedsiParentChatScreen)return;
  const $=id=>document.getElementById(id);
  const t=window.MedsiOverlayTransport;
  if(!t)return;
  const REACTIONS=['❤️','👍','👌','🙏','🥰','😁','🔥'];
  const LIVE_REFRESH_MS=5000;
  const p10=v=>String(v||'').replace(/\D+/g,'').slice(-10);
  const fmt=v=>{const d=new Date(Number(v));return Number.isNaN(d.getTime())?'':d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})};
  function moscowDay(value){
    const d=new Date(Number(value));if(Number.isNaN(d.getTime()))return null;
    const parts=Object.fromEntries(new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const year=Number(parts.year),month=Number(parts.month),day=Number(parts.day);
    if(!year||!month||!day)return null;
    return{year,month,day,key:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`};
  }
  function dateChip(value){
    const p=moscowDay(value),n=moscowDay(Date.now());if(!p)return null;
    let label='';
    if(n){
      const current=Date.UTC(n.year,n.month-1,n.day),target=Date.UTC(p.year,p.month-1,p.day),diff=Math.round((current-target)/86400000);
      if(diff===0)label='Сегодня';else if(diff===1)label='Вчера';
    }
    if(!label)label=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',...(n&&p.year===n.year?{}:{year:'numeric'})}).format(new Date(Number(value)));
    return{key:p.key,label};
  }
  let state=null,rows=[],busy=false,dead=false,chatClosed=false,chatPending=false,lightbox=null,reactionMenu=null,liveTimer=0,liveRunning=false,initialMessagesRendered=false,retryDraft=null,assistantCard=null,assistantDraft='',assistantBypass='';

  const ASSISTANT_ANSWERS={
    reportDelay:'Вы про утренний отчёт или вечерний отчёт?',
    reportRequest:'',
    reports:'Утренний отчёт с 15:00 до 16:00.\nВечерний — с 21:00 до 22:00.',
    delivery:'🗺️ Адрес: Гринвуд, с11, Путилково\nДля курьера напишите «на 5 этаж» и имя ребёнка.\n\n✅ Что можно привезти или заказать:\nЛюбую еду и напитки в безопасной упаковке - пиццу, суши, сладости, фрукты, сок. Также можно передать одежду, книги, раскраски, творческие наборы, безопасную канцелярию.\n\n🚫 Что нельзя передавать:\nОстрые и колюще-режущие предметы (ножницы, лезвия, точилки), стекло, металлические банки, аэрозоли и столовые приборы. Также нельзя кофе, энергетики, табак, вейпы и личную электронику.\n\n💊 Лекарства — только после согласования с лечащим врачом.\n❓ Если сомневаетесь насчёт вещи, уточните у воспитателей.',
    meetings:'Встречу с ребёнком, пожалуйста, согласуйте с лечащим врачом. Он поможет выбрать время с учётом состояния ребёнка.',
    meetTime:'Актуальное время встречи зависит от дня и состояния ребёнка. Пожалуйста, согласуйте встречу с лечащим врачом — он подскажет подходящее время.',
    calls:'Звонок ребёнку, пожалуйста, согласуйте с лечащим врачом. Он поможет выбрать подходящее время.',
    doctors:'Контакты врачей:\n\nАнастасия Михайловна\n+79253394090\nРабочие часы: с 9:00 до 18:00.\nВыходные дни: пятница и суббота.\n\nАнтон Геннадьевич\n+79859927884\nРабочие часы: с 9:00 до 18:00.\nВыходные дни: воскресенье и понедельник.\n\nПожалуйста, пишите и звоните врачам в рабочее время.',
    payment:'По вопросам оплаты, пожалуйста, уточните информацию у лечащего врача или на ресепшене клиники.',
    routine:'☀️ Утро\n8:00 — Подъём\n8:30 — Зарядка\n9:00 — Завтрак\n9:30 — Игры и творчество\n10:00 — Групповая психотерапия\n11:00 — Прогулка\n12:00 — Игры и творчество\n13:00 — Обед\n14:00 — Сон-час\n\n🌙 Вечер\n16:00 — Танцы\n16:30 — Полдник\n17:00 — Игры и творчество\n18:00 — Ужин\n18:15 — Киносеанс\n21:00 — Подготовка ко сну / медицинские процедуры\n22:00 — Отбой\n\nВстречи с детьми: 17:00–20:00.',
    writeEducators:'Напишите воспитателям в чате — они ответят, как только смогут.',
    medical:'Вопросы о лечении, препаратах, процедурах и анализах, пожалуйста, обсуждайте с лечащим врачом. Воспитатели не владеют такой информацией.',
    medicine:'Вопросы о лекарствах, назначениях и дозировках, пожалуйста, обсуждайте с лечащим врачом. Воспитатели не владеют такой информацией.',
    individualTherapy:'По вопросам индивидуальной психотерапии, пожалуйста, связывайтесь напрямую с вашим психологом.'
  };
  const DOCTOR_CONTACT_INTENTS=new Set(['meetings','meetTime','calls','payment','medical','medicine']);
  function assistantHumanOnlyText(text){
    const value=String(text||'').toLocaleLowerCase('ru').replace(/ё/g,'е');
    return /(?:срочн|экстренн|неотложн|немедленн|жалоб|претенз|возмущ|сколько можно|безобраз|ужас|игнор|почему вы|вы не отвеч|требую)/.test(value)
      || /(?:передайте|позовите|попросите|проверьте|ответьте|разбудите|подойдите|перезвоните|позвоните)\s/.test(value)
      || /скажите\s+(?:ребенку|ему|ей|врачу|доктору)/.test(value);
  }
  function assistantSensitiveState(text){
    const value=String(text||'').toLocaleLowerCase('ru').replace(/ё/g,'е');
    return /(?:болит|температур|тошнит|рвот|рвет|плохо|слабост|обморок|кров|дыш|удуш|тревог|паник|плач|истерик|суицид|самоповреж|не ест|не спит|ухудш)/.test(value);
  }
  function assistantUnsafeSuggestion(text,key){
    const value=String(text||'').toLocaleLowerCase('ru').replace(/ё/g,'е');
    if(assistantHumanOnlyText(value))return true;
    if((key==='medical'||key==='medicine')&&assistantSensitiveState(value))return true;
    if(key==='delivery'&&/(?:курьер[^.?!]*(?:едет|приех|опозд|потер)|не достав|отмен|уже (?:получ|привез|переда)|спасибо[^.?!]*достав)/.test(value))return true;
    return false;
  }
  function assistantIntent(text){
    const bot=window.MedsiSmartBot;if(!bot||typeof bot.analyze!=='function')return null;
    let result;try{result=bot.analyze(text)}catch(_){return null}
    if(!result||result.confidence<0.9)return null;
    const intent=result.intent,key=typeof intent==='string'?intent:intent&&intent.key;
    if(!key||!Object.prototype.hasOwnProperty.call(ASSISTANT_ANSWERS,key))return null;
    if(assistantUnsafeSuggestion(text,key))return null;
    // Срочные и напрямую адресованные воспитателям сообщения остаются обычными.
    if(['urgent','writeEducators','educators','childStatus','clarifyReportMedical','clarifyDoctorMeeting'].includes(key))return null;
    if(key==='delivery'&&intent&&intent.variant==='medicine')return{key,kind:intent.kind||'',variant:intent.variant,answer:ASSISTANT_ANSWERS.delivery};
    return{key,kind:intent&&typeof intent==='object'?intent.kind:'',variant:intent&&typeof intent==='object'?intent.variant:'',answer:ASSISTANT_ANSWERS[key]};
  }
  function moscowDateKey(value){const date=new Date(value);if(Number.isNaN(date.getTime()))return'';const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return parts.filter(p=>p.type!=='literal').map(p=>p.value).join('-')}
  function assistantReportStatus(kind){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    const minutes=Number(parts.hour)*60+Number(parts.minute);if(kind==='evening'&&minutes<180)return'late';
    const start=kind==='morning'?900:1260,end=kind==='morning'?960:1320;
    return minutes<start?'before':minutes<end?'publishing':minutes<end+60?'grace':'late';
  }
  function assistantReportDelayText(kind){
    const status=assistantReportStatus(kind),title=kind==='morning'?'Утренний':'Вечерний',window=kind==='morning'?'с 15:00 до 16:00':'с 21:00 до 22:00';
    if(status==='before')return`${title} отчёт обычно появляется ${window}. Пожалуйста, дождитесь этого времени.`;
    if(status==='publishing')return`Сейчас идёт окно публикации: ${window}. Пожалуйста, дождитесь его окончания.`;
    if(status==='grace')return'Похоже, сегодня подготовка отчёта занимает немного больше времени. Пожалуйста, подождите ещё немного.';
    return'Пожалуйста, попробуйте перезапустить приложение. Если отчет все еще не появится, вероятно произошла ошибка. Пожалуйста, сообщите воспитателям в чате 🙏';
  }
  function assistantExpectedReportDate(kind){
    const now=Date.now();
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Moscow',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
    return kind==='evening'&&Number(parts.hour)<3?moscowDateKey(now-24*60*60*1000):moscowDateKey(now);
  }
  async function assistantReportAnswer(kind,delayed){
    try{
      const session=await currentSession(),current=await t.request(session,'/lab/report-current');
      if(!current)return'Чтобы я мог проверить отчёт, пожалуйста, войдите в Медси Бот.';
      const currentReports=(current.reports||[]).filter(item=>['morning','evening'].includes(item.kind)&&String(item.text||'').trim());
      let history=[],historyAvailable=true;
      try{history=(await t.request(session,'/lab/report-history')).reports||[]}catch(_){historyAvailable=false}
      const found=currentReports.find(item=>item.kind===kind);
      const expectedDate=assistantExpectedReportDate(kind);
      const published=history.find(item=>item.kind===kind&&item.reportDate===expectedDate&&String(item.text||'').trim());
      const previous=history.find(item=>item.kind===kind&&String(item.text||'').trim());
      const changedFromHistory=!!(found&&previous&&String(found.text).trim()!==String(previous.text).trim());
      const title=kind==='morning'?'утренний':'вечерний';
      const window=kind==='morning'?'с 15:00 до 16:00':'с 21:00 до 22:00';
      if(!delayed){
        if(published)return published.text;
        if(assistantReportStatus(kind)!=='before'&&changedFromHistory)return found.text;
        if(!historyAvailable)return`Сейчас не получилось проверить, опубликован ли сегодняшний ${title} отчёт. Пожалуйста, попробуйте ещё раз чуть позже.`;
        return`Сегодняшний ${title} отчёт пока не опубликован. Обычно он появляется ${window}.`;
      }
      if(published)return published.text;
      if(assistantReportStatus(kind)!=='before'&&changedFromHistory)return found.text;
      if(!historyAvailable)return'Сейчас не получилось проверить, опубликован ли новый отчёт. Пожалуйста, попробуйте ещё раз чуть позже.';
      return assistantReportDelayText(kind);
    }catch(_){return delayed?'Сейчас не получилось проверить, опубликован ли новый отчёт. Пожалуйста, попробуйте ещё раз чуть позже.':'Сейчас не получилось загрузить отчёт. Пожалуйста, попробуйте ещё раз чуть позже.'}
  }
  async function assistantAnswer(suggestion){
    if(suggestion.key==='reportDelay')return suggestion.kind?assistantReportAnswer(suggestion.kind,true):ASSISTANT_ANSWERS.reportDelay;
    if(suggestion.key==='reportRequest')return suggestion.kind?assistantReportAnswer(suggestion.kind,false):ASSISTANT_ANSWERS.reports;
    if(suggestion.key==='medical'&&suggestion.variant==='medicine')return ASSISTANT_ANSWERS.medicine;
    return suggestion.answer;
  }
  function closeAssistantCard(keepDraft=true,bypass=false){
    if(assistantCard){assistantCard.remove();assistantCard=null}
    const input=$('parentChatInput');if(bypass&&keepDraft)assistantBypass=assistantDraft;
    assistantDraft='';input.disabled=busy||chatClosed||chatPending;$('parentChatSend').disabled=busy||chatClosed||chatPending;$('parentChatAttach').disabled=busy||chatClosed||chatPending;
  }
  function assistantButton(label,action,kind){const button=document.createElement('button');button.type='button';button.className='parent-assistant-action'+(kind?' '+kind:'');button.textContent=label;button.onclick=action;return button}
  function showAssistantCard(text,answer){
    closeAssistantCard(false);assistantDraft=text;
    const host=document.body;if(!host)return;
    const card=document.createElement('section');card.className='parent-assistant-card is-compact';card.setAttribute('role','dialog');card.setAttribute('aria-label','Подсказка Медси Бота');
    const close=document.createElement('button');close.type='button';close.className='parent-assistant-close';close.setAttribute('aria-label','Закрыть подсказку');close.textContent='×';close.onclick=()=>closeAssistantCard(true,true);
    const mascot=document.createElement('span');mascot.className='parent-assistant-mascot';mascot.setAttribute('aria-hidden','true');mascot.innerHTML='<span class="medsi-character"><img class="medsi-character-body" src="/parents/blob.webp" alt=""><span class="medsi-character-eyes"><i class="medsi-character-eye"></i><i class="medsi-character-eye"></i></span></span>';
    const title=document.createElement('strong');title.className='parent-assistant-title';title.textContent='Медси Бот';
    const body=document.createElement('div');body.className='parent-assistant-copy';body.textContent='Хотите, я отвечу?';
    const actions=document.createElement('div');actions.className='parent-assistant-actions';
    const suggestion=assistantIntent(text);
    function expandAssistantCard(){card.classList.remove('is-compact');card.classList.add('is-expanded')}
    function showResolutionActions(){actions.replaceChildren(assistantButton('Да, вопрос решился',()=>showAssistantFollowup(true)),assistantButton('Нет',()=>showAssistantFollowup(false),'secondary'))}
    async function presentAnswer(selected){
      expandAssistantCard();body.textContent=await assistantAnswer(selected);actions.replaceChildren();
      const needsDoctorContacts=DOCTOR_CONTACT_INTENTS.has(selected.key)||(selected.key==='delivery'&&selected.variant==='medicine');
      if(needsDoctorContacts){
        actions.append(assistantButton('Контакты врача',()=>{body.textContent=ASSISTANT_ANSWERS.doctors;showResolutionActions()}),assistantButton('Да, вопрос решился',()=>showAssistantFollowup(true)),assistantButton('Нет',()=>showAssistantFollowup(false),'secondary'));
        return;
      }
      showResolutionActions();
    }
    function showReportKindChoices(prompt){
      expandAssistantCard();body.textContent=prompt;
      actions.replaceChildren(assistantButton('Утренний отчёт',()=>presentAnswer({...suggestion,kind:'morning'})),assistantButton('Вечерний отчёт',()=>presentAnswer({...suggestion,kind:'evening'})));
    }
    function beginAnswer(){
      if(suggestion&&suggestion.key==='reportDelay'&&!suggestion.kind){
        showReportKindChoices('Вы про утренний отчёт или вечерний отчёт?');
        return;
      }
      if(suggestion&&suggestion.key==='reportRequest'&&!suggestion.kind){
        showReportKindChoices('Какой отчёт показать?');
        return;
      }
      presentAnswer(suggestion||{answer:''});
    }
    actions.append(assistantButton('Да',beginAnswer),assistantButton('Нет',()=>{const draft=assistantDraft;closeAssistantCard(false);assistantBypass=draft;$('parentChatCompose').onsubmit({preventDefault(){}})},'secondary'));
    card._suggestion=suggestion;
    card.append(close,mascot,title,body,actions);host.appendChild(card);assistantCard=card;
    $('parentChatInput').disabled=true;$('parentChatSend').disabled=true;$('parentChatAttach').disabled=true;
  }
  function showAssistantFollowup(resolved){
    if(!assistantCard)return;const body=assistantCard.querySelector('.parent-assistant-copy'),actions=assistantCard.querySelector('.parent-assistant-actions');
    assistantCard.classList.remove('is-compact');assistantCard.classList.add('is-expanded');
    if(resolved){
      const input=$('parentChatInput');if(input.value===assistantDraft)input.value='';
      body.textContent='Хорошо, тогда вопрос воспитателям не отправляю.';
      actions.replaceChildren(assistantButton('Закрыть',()=>{closeAssistantCard(false);assistantBypass='';focusComposer()},'secondary'));
      return;
    }
    body.textContent='Отправить вопрос воспитателям?';
    actions.replaceChildren(assistantButton('Да, отправить',()=>{const draft=assistantDraft;closeAssistantCard(false);assistantBypass=draft;$('parentChatCompose').onsubmit({preventDefault(){}})},'primary'),assistantButton('Нет',()=>{const input=$('parentChatInput');if(input.value===assistantDraft)input.value='';closeAssistantCard(false);assistantBypass='';focusComposer()},'secondary'));
  }

  function mediaUrl(m){
    const id=String(m&&m.fileId||'');if(!id)return'';
    // The shared transport rejects all legacy KV/R2/Drive references until
    // their S3 migration is explicitly verified. Never call external media.
    return typeof t.mediaUrl==='function'?t.mediaUrl(id,'w1600'):'';
  }
  function receiptState(m){
    if(!m||String(m.side||'')!=='parent')return[];
    return [
      m.readByEducator,m.readByEducatorAt,m.educatorRead,m.educatorReadAt,m.read_by_educator,m.educator_read_at,
      m.readByOther,m.otherReadAt,m.isRead,m.read
    ]
  }
  function threadSig(list){
    return JSON.stringify((list||[]).map(m=>[
      m&&m.messageKey||'',m&&m.side||'',m&&m.type||'',m&&m.text||'',m&&m.fileId||'',
      m&&m.reaction||'',m&&m.editedAt||'',m&&m.timestamp||'',
      m&&m.replyToKey||'',m&&m.reply&&m.reply.messageKey||'',m&&m.reply&&m.reply.text||'',receiptState(m)
    ]))
  }
  function messageKey(m){const key=String(m&&m.messageKey||'').trim();return key||['fallback',m&&m.side||'',m&&m.timestamp||'',m&&m.type||'',m&&m.fileId||'',m&&m.text||''].join('|')}
  function messageSig(m){return JSON.stringify([m&&m.side||'',m&&m.type||'',m&&m.text||'',m&&m.fileId||'',m&&m.reaction||'',m&&m.editedAt||'',m&&m.timestamp||'',m&&m.replyToKey||'',m&&m.reply&&m.reply.messageKey||'',m&&m.reply&&m.reply.text||'',receiptState(m)])}
  function isPending(m){return String(m&&m.messageKey||'').startsWith('pending-')}
  function samePendingMessage(pending,confirmed){return isPending(pending)&&!isPending(confirmed)&&String(pending&&pending.side||'')===String(confirmed&&confirmed.side||'')&&String(pending&&pending.type||'')===String(confirmed&&confirmed.type||'')&&String(pending&&pending.text||'')===String(confirmed&&confirmed.text||'')&&String(pending&&pending.fileId||'')===String(confirmed&&confirmed.fileId||'')&&Math.abs(Number(pending&&pending.timestamp||0)-Number(confirmed&&confirmed.timestamp||0))<120000}
  function nearBottom(){const box=$('parentChatMessages');return !box||box.scrollHeight-box.scrollTop-box.clientHeight<90}
  function scrollBottom(smooth){const box=$('parentChatMessages');if(!box)return;requestAnimationFrame(()=>box.scrollTo({top:box.scrollHeight,behavior:smooth?'smooth':'auto'}))}
  function showError(msg){const e=$('parentChatError');if(!e)return;e.textContent=String(msg||'Не удалось открыть чат.');e.classList.toggle('is-reconnecting',String(msg).startsWith('Восстанавливаем'));e.classList.remove('hidden')}
  function clearError(){const e=$('parentChatError');if(!e)return;e.textContent='';e.classList.add('hidden')}
  function setBusy(v){busy=!!v;const disabled=busy||chatClosed||chatPending;$('parentChatInput').disabled=disabled;$('parentChatSend').disabled=disabled;$('parentChatAttach').disabled=disabled}
  function messageText(value){return String(value||'').replace(/\r\n?/g,'\n').trim()}
  function newMessageId(){return typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():'msg-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)}
  function focusComposer(){
    const input=$('parentChatInput'),screen=$('screenChat');
    if(!state||dead||chatClosed||!input||input.disabled||!screen||screen.classList.contains('hidden')||document.body.dataset.screen!=='screenChat')return;
    requestAnimationFrame(()=>{
      if(!state||dead||chatClosed||input.disabled||screen.classList.contains('hidden')||document.body.dataset.screen!=='screenChat')return;
      try{input.focus({preventScroll:true})}catch(_){input.focus()}
    });
  }
  function isChatClosedError(error){return !!(error&&(error.code==='CHAT_CLOSED'||Number(error.status)===410))}
  function stopLive(){if(liveTimer){clearTimeout(liveTimer);liveTimer=0}liveRunning=false}
  function chatVisible(){const screen=$('screenChat');return !!state&&!dead&&!chatClosed&&!document.hidden&&document.body.dataset.screen==='screenChat'&&screen&&!screen.classList.contains('hidden')}
  function scheduleLive(delay){
    if(liveTimer)clearTimeout(liveTimer);
    if(!state||dead||chatClosed)return;
    const active=state;
    liveTimer=setTimeout(async()=>{
      liveTimer=0;
      if(chatVisible()&&!liveRunning){
        liveRunning=true;
        try{await refresh({fresh:true,silent:true,background:true});if(chatPending){chatPending=false;setBusy(false)}}catch(err){if(isChatClosedError(err)){if(!chatPending)showClosedChat();else if(state.confirmChatClosed){const confirmed=await state.confirmChatClosed().catch(()=>false);if(confirmed)showClosedChat()}} }
        finally{if(state===active)liveRunning=false}
      }
      if(state===active)scheduleLive(LIVE_REFRESH_MS);
    },Math.max(150,Number(delay)||LIVE_REFRESH_MS))
  }
  function showClosedChat(){
    chatClosed=true;chatPending=false;rows=[];stopLive();clearError();closeReactionMenu();
    const box=$('parentChatMessages');
    if(box){box.replaceChildren();const e=document.createElement('div');e.className='parent-chat-empty';e.textContent='Чат с воспитателями закрыт.';box.appendChild(e)}
    $('parentChatInput').value='';setBusy(false);
  }
  function showPendingChat(){
    chatClosed=false;chatPending=true;rows=[];clearError();closeReactionMenu();
    const box=$('parentChatMessages');
    if(box){box.replaceChildren();const e=document.createElement('div');e.className='parent-chat-empty';e.textContent='Сообщений пока нет.';box.appendChild(e)}
    setBusy(false);
  }

  function closeLightbox(){if(!lightbox)return;lightbox.remove();lightbox=null}
  function openLightbox(src,alt){
    closeLightbox();
    const root=document.createElement('div');root.className='parent-chat-lightbox';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Просмотр фотографии');
    const img=document.createElement('img');img.src=src;img.alt=alt||'Фотография из чата';
    const close=document.createElement('button');close.type='button';close.className='parent-chat-lightbox-close';close.setAttribute('aria-label','Закрыть фотографию');close.textContent='×';
    close.onclick=closeLightbox;root.onclick=e=>{if(e.target===root)closeLightbox()};
    root.append(img,close);document.body.appendChild(root);lightbox=root;
  }

  function ensureReactionMenu(){
    if(reactionMenu)return reactionMenu;
    const menu=document.createElement('div');menu.className='parent-chat-context hidden';menu.setAttribute('role','menu');
    document.body.appendChild(menu);reactionMenu=menu;return menu;
  }
  function closeReactionMenu(){if(reactionMenu)reactionMenu.classList.add('hidden')}
  function openReactionMenu(m,el){
    if(chatClosed||!state||!m||!m.messageKey||String(m.messageKey).startsWith('pending-'))return;
    const menu=ensureReactionMenu();menu.replaceChildren();
    REACTIONS.forEach(reaction=>{
      const b=document.createElement('button');b.type='button';b.className='parent-chat-reaction-btn';b.textContent=reaction;b.setAttribute('aria-label','Поставить реакцию '+reaction);
      b.onclick=async ev=>{ev.preventDefault();ev.stopPropagation();closeReactionMenu();try{await t.react(await currentSession(),m.messageKey,reaction);await refresh({stick:false,fresh:true})}catch(err){if(isChatClosedError(err))showClosedChat();else showError(err&&err.message||'Не удалось поставить реакцию.')}};
      menu.appendChild(b);
    });
    const r=el.getBoundingClientRect();
    menu.classList.remove('hidden');
    const w=Math.min(310,window.innerWidth-24);
    menu.style.left=Math.min(window.innerWidth-w-12,Math.max(12,r.left+(r.width-w)/2))+'px';
    const menuH=54;let top=r.bottom+7;if(top+menuH>window.innerHeight)top=Math.max(12,r.top-menuH-7);menu.style.top=top+'px';
  }
  document.addEventListener('click',e=>{if(reactionMenu&&!reactionMenu.classList.contains('hidden')&&!e.target.closest('.parent-chat-context,.parent-chat-msg'))closeReactionMenu()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeLightbox();closeReactionMenu()}});

  function messageNode(m,quiet,stick){
      const el=document.createElement('article');el.className='parent-chat-msg '+(m.side==='parent'?'parent':'educator');el.dataset.medsiMessageKey=messageKey(m);el.dataset.medsiMessageSignature=messageSig(m);
      if(quiet)el.dataset.medsiAnimated='1';
      const author=document.createElement('div');author.className='parent-chat-author';
      author.textContent=m.side==='parent'
        ?'Родитель'+(state.parentName?' '+state.parentName:'')
        :'Детское Отделение Медси';
      el.appendChild(author);
      const u=mediaUrl(m);
      const previewUrl=m.type==='image'&&typeof t.mediaPreviewUrl==='function'?t.mediaPreviewUrl(m.fileId,'w960'):u;
      if(u){
        const frame=document.createElement('div');frame.className='parent-chat-media-frame';
        const md=document.createElement(m.type==='video'?'video':'img');md.className='parent-chat-media';
        const markReady=()=>{frame.classList.add('medsi-media-ready');md.classList.add('is-loaded','medsi-media-ready');if(m.type==='image'&&window.MedsiMediaPreload)window.MedsiMediaPreload.queueOriginal(u);if(stick&&nearBottom())scrollBottom(false)};
        if(m.type==='video'){
          frame.style.cursor='default';md.controls=true;md.preload='metadata';md.onloadedmetadata=markReady;
        } else {
          md.alt='Фотография из чата';
          md.onload=markReady;
          frame.onclick=e=>{e.preventDefault();e.stopPropagation();openLightbox(u,md.alt)};
        }
        frame.appendChild(md);el.appendChild(frame);md.src=previewUrl;
        if((md.tagName==='IMG'&&md.complete&&md.naturalWidth>0)||(md.tagName==='VIDEO'&&md.readyState>=1))markReady();
      }
      if(m.text){const b=document.createElement('div');b.textContent=String(m.text);el.appendChild(b)}
      if(m.reaction){const r=document.createElement('span');r.className='parent-chat-reaction';r.textContent=String(m.reaction);el.appendChild(r)}
      const tm=document.createElement('span');tm.className='parent-chat-time';tm.textContent=fmt(m.timestamp);el.appendChild(tm);
      const openContext=e=>{if(e.type==='click'&&e.target.closest('img,video,button,.parent-chat-reaction'))return;e.preventDefault();e.stopPropagation();openReactionMenu(m,el)};
      el.onclick=openContext;
      el.addEventListener('medsi:message-longpress',openContext);
      return el
  }
  function render(list,opts){
    const box=$('parentChatMessages');if(!box)return;
    closeReactionMenu();
    const stick=opts&&opts.stick!==undefined?!!opts.stick:nearBottom();
    const preserveExact=!!(opts&&opts.preserveExact);
    const animateInitial=!!(opts&&opts.animateInitial)&&!initialMessagesRendered;
    const oldHeight=box.scrollHeight,oldTop=box.scrollTop;
    const previousRows=rows,updatedRows=Array.isArray(list)?list:[];
    if(!updatedRows.length){rows=updatedRows;initialMessagesRendered=true;const e=document.createElement('div');e.className='parent-chat-empty';e.textContent='Сообщений пока нет.';box.replaceChildren(e);return}
    const existing=new Map([...box.children].filter(el=>el.matches&&el.matches('.parent-chat-msg')&&el.dataset.medsiMessageKey).map(el=>[el.dataset.medsiMessageKey,el]));
    const hadMessages=existing.size>0;
    const hasStableOverlap=updatedRows.some(m=>existing.has(messageKey(m)));
    const quietAllNew=hadMessages&&!hasStableOverlap;
    const existingOrder=[...box.children].filter(el=>el.matches&&el.matches('.parent-chat-msg')).map(el=>el.dataset.medsiMessageKey||'');
    const sameOrder=existingOrder.length===updatedRows.length&&updatedRows.every((m,index)=>existingOrder[index]===messageKey(m));
    if(sameOrder){
      updatedRows.forEach(m=>{const old=existing.get(messageKey(m));if(old&&old.dataset.medsiMessageSignature!==messageSig(m))old.replaceWith(messageNode(m,true,stick))});
      rows=updatedRows;
      return;
    }
    const pendingRows=previousRows.filter(isPending),usedPending=new Set();
    const messageNodes=updatedRows.map((m,index)=>{
      const key=messageKey(m),sig=messageSig(m),old=existing.get(key);
      if(old&&old.dataset.medsiMessageSignature===sig)return old;
      if(old)return messageNode(m,true,stick);
      const pending=pendingRows.find(row=>!usedPending.has(messageKey(row))&&samePendingMessage(row,m));
      if(pending)usedPending.add(messageKey(pending));
      const quiet=!animateInitial||quietAllNew||!!pending||(!hadMessages&&index<updatedRows.length-14);
      return messageNode(m,quiet,stick)
    });
    rows=updatedRows;
    initialMessagesRendered=true;
    const fragment=document.createDocumentFragment();
    let previousDay='';
    rows.forEach((m,i)=>{const chip=dateChip(m&&m.timestamp);if(chip&&chip.key!==previousDay){const sep=document.createElement('div');sep.className='medsi-date-separator';sep.dataset.dateKey=chip.key;sep.textContent=chip.label;fragment.appendChild(sep);previousDay=chip.key}fragment.appendChild(messageNodes[i])});
    box.replaceChildren(fragment);
    requestAnimationFrame(()=>{
      if(stick)box.scrollTo({top:box.scrollHeight,behavior:'auto'});
      else if(preserveExact)box.scrollTop=Math.max(0,oldTop);
      else box.scrollTop=Math.max(0,oldTop+(box.scrollHeight-oldHeight));
    })
  }

  async function currentSession(force){
    const active=state;if(!active||dead)throw new Error('Чат закрыт.');
    const session=active.getSession?await active.getSession(force):active.session;
    if(state!==active||dead)throw new Error('Чат закрыт.');
    if(!session)throw new Error('Восстанавливаем соединение…');
    active.session=session;return session;
  }
  async function fetchThread(fresh){
    const active=state;let session=await currentSession();
    let res;
    try{res=await t.thread(session,active.phone,'',100,fresh?{fresh:true}:undefined);}
    catch(error){if(Number(error.status)!==401||!active.getSession||state!==active)throw error;session=await currentSession(true);res=await t.thread(session,active.phone,'',100,{fresh:true});}
    return Array.isArray(res&&res.messages)?res.messages:[];
  }
  async function refresh(opts){
    opts=opts||{};
    const active=state;const list=await fetchThread(!!opts.fresh);if(dead||!state||state!==active)return list;clearError();
    const changed=threadSig(list)!==threadSig(rows);
    const shouldRender=!initialMessagesRendered||!!opts.force||changed;
    if(shouldRender){
      const stick=opts.stick!==undefined?!!opts.stick:nearBottom();
      render(list,{stick,preserveExact:!!opts.background&&!stick,animateInitial:!initialMessagesRendered});
    }else rows=list;
    if((changed||opts.forceRead)&&!chatClosed){
      if(!state.readOnly)t.markRead(state.session,'parent',state.phone).catch(err=>{if(isChatClosedError(err))showClosedChat()});
    }
    return list
  }

  async function open(next){
    closeAssistantCard(false);assistantBypass='';stopLive();dead=false;chatClosed=false;chatPending=false;state={...next,phone:p10(next&&next.phone)};rows=[];initialMessagesRendered=false;clearError();closeReactionMenu();setBusy(false);if(window.MedsiMediaPreload)window.MedsiMediaPreload.reset();
    document.body.classList.toggle('parent-preview-chat',!!state.readOnly);
    $('parentChatChild').textContent=state.childName||state.parentName||'Ребёнок';
    $('parentChatPhone').textContent=state.phone?'8'+state.phone:'';
    $('parentChatInput').value=retryDraft&&retryDraft.phone===state.phone?retryDraft.text:'';
    const active=state;
    const cached=window.MedsiParentPrewarm?MedsiParentPrewarm.peek(state.phone):null;
    const hasCached=!!(cached&&Array.isArray(cached.messages));
    if(hasCached){$('parentChatMessages').replaceChildren();render(cached.messages,{stick:true,animateInitial:true});}
    else $('parentChatMessages').innerHTML='<div class="parent-chat-empty">Загружаем сообщения…</div>';
    let opened=false;
    for(let attempt=0;attempt<3&&!opened&&state===active&&!dead;attempt++){
      try{await refresh({stick:true,fresh:true,force:!hasCached||attempt>0,forceRead:true});if(state!==active||dead)return;opened=true;chatPending=false;setBusy(false)}
      catch(e){
        if(state!==active||dead)return;
        if(!isChatClosedError(e)){showError('Восстанавливаем соединение…');break}
        // Immediately after registration the profile mirror may still be
        // settling.  Give it a couple of short, silent retries before
        // declaring the chat genuinely closed.
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,700*(attempt+1)));
        else {const confirmed=state.confirmChatClosed?await state.confirmChatClosed().catch(()=>false):false;if(confirmed)showClosedChat();else {showPendingChat();scheduleLive(1200);}}
      }
    }
    if(state===active&&!dead&&!chatClosed)scheduleLive(opened?LIVE_REFRESH_MS:1500)
  }
  function close(){document.body.classList.remove('parent-preview-chat');closeAssistantCard(false);assistantBypass='';stopLive();dead=true;state=null;rows=[];chatClosed=false;chatPending=false;setBusy(false);clearError();closeLightbox();closeReactionMenu()}

  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state&&!dead&&!chatClosed)scheduleLive(250)});
  window.addEventListener('online',()=>{if(state&&!dead&&!chatClosed)scheduleLive(250)});

  $('parentChatBack').onclick=()=>{if(state&&typeof state.onBack==='function')state.onBack()};
  $('parentChatCompose').onsubmit=async e=>{
    e.preventDefault();if(!state||state.readOnly||busy||chatClosed)return;const text=messageText($('parentChatInput').value);if(!text)return;
    const isRetry=retryDraft&&retryDraft.phone===state.phone&&retryDraft.text===text;
    if(!isRetry&&assistantBypass!==text){const suggestion=assistantIntent(text);if(suggestion){showAssistantCard(text,suggestion.answer);return}}
    assistantBypass='';
    const active=state,clientMessageId=retryDraft&&retryDraft.phone===active.phone&&retryDraft.text===text?retryDraft.clientMessageId:newMessageId();
    retryDraft={phone:active.phone,text,clientMessageId};
    setBusy(true);const optimistic={side:'parent',type:'text',text,timestamp:Date.now(),messageKey:'pending-'+Date.now().toString(36)};
    render(rows.concat(optimistic),{stick:true});$('parentChatInput').value='';
    try{
      const sent=await t.sendMessage(await currentSession(),'parent',active.phone,{type:'text',text,clientMessageId});
      if(retryDraft&&retryDraft.clientMessageId===clientMessageId)retryDraft=null;
      if(state!==active||dead)return;
      clearError();
      const confirmed=sent&&sent.message,next=rows.filter(m=>messageKey(m)!==optimistic.messageKey);
      if(confirmed&&confirmed.messageKey&&!next.some(m=>messageKey(m)===confirmed.messageKey))next.push(confirmed);
      render(next,{stick:true});
      refresh({stick:true,fresh:true}).catch(()=>{if(state===active&&!dead)scheduleLive(1200)});
    }catch(err){
      if(state!==active||dead)return;
      if(isChatClosedError(err))showClosedChat();
      else{
        render(rows.filter(m=>messageKey(m)!==optimistic.messageKey),{stick:true});
        if(!$('parentChatInput').value.trim())$('parentChatInput').value=text;
        showError((err&&err.message||'Не удалось подтвердить отправку.')+' Текст сохранён; попробуйте ещё раз.');
      }
    }finally{if(state===active&&!dead){setBusy(false);focusComposer()}}
  };
  $('parentChatAttach').onclick=()=>{if(state&&!state.readOnly&&!chatClosed)$('parentChatFile').click()};
  $('parentChatFile').onchange=async()=>{
    if(!state||state.readOnly||busy||chatClosed)return;const input=$('parentChatFile'),f=input.files&&input.files[0];input.value='';if(!f)return;
    if(!/^image\//i.test(f.type)&&!/^video\//i.test(f.type)){showError('Можно прикреплять только фото или видео.');return}
    const maxBytes=Number(t.maxUploadBytes||100*1024*1024);if(f.size>maxBytes){showError('Размер файла не должен превышать 100 МБ.');return}
    setBusy(true);clearError();
    try{const up=await t.upload(await currentSession(),state.phone,f);const sent=await t.sendMessage(await currentSession(),'parent',state.phone,{type:up.type||(f.type.startsWith('video/')?'video':'image'),text:'',fileId:up.fileId});clearError();const confirmed=sent&&sent.message;if(confirmed&&confirmed.messageKey&&!rows.some(m=>messageKey(m)===confirmed.messageKey))render(rows.concat(confirmed),{stick:true});refresh({stick:true,fresh:true}).catch(()=>scheduleLive(1200))}
    catch(err){if(isChatClosedError(err))showClosedChat();else showError((err&&err.message||'Не удалось подтвердить отправку файла.')+' Проверьте чат перед повтором.')}
    finally{setBusy(false)}
  };

  window.MedsiParentChatScreen={open,close,refresh};
})();
