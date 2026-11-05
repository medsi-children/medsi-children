(function(){
  function make(tag, cls, text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el}
  function card(kind,title,text,action){const b=make('button','tutor-start-card '+kind);b.type='button';b.dataset.action=action;b.append(make('span','tutor-start-card-title',title),make('span','tutor-start-card-text',text));return b}
  function mount(opts){
    const root=make('section');root.id='tutorStartShell';
    const frame=make('article','tutor-start-frame');const scene=make('div','tutor-start-scene');
    const brand=make('div','tutor-start-brand');const logo=make('div','tutor-start-logo');for(let i=0;i<5;i++)logo.append(make('span'));
    brand.append(logo,make('h1','tutor-start-title','Медси Бот'),make('p','tutor-start-subtitle','Панель воспитателей и психологов для отчётов, телефонов родителей и чатов'));
    const actions=make('div','tutor-start-actions');
    actions.append(card('chat','💬 Чат с родителями','Написать родителю и ответить на вопросы.','chat'));
    const reports=make('div','tutor-start-grid');reports.append(card('morning','☀️ Утренний отчёт','Отправить утренний отчёт.','morning'),card('evening','🌙 Вечерний отчёт','Отправить вечерний отчёт.','evening'));
    const secondary=make('div','tutor-start-grid');secondary.append(card('therapy','🧠 Групповая терапия','Отправить отчёт по групповой терапии.','psychology'),card('phones','📞 Телефоны','Дать ребёнку позвонить родителю.','phones'));
    actions.append(reports,secondary);scene.append(brand,actions);frame.append(scene);root.append(frame);document.body.append(root);
    let ready=false,pending='';
    function hide(){root.classList.add('hidden');setTimeout(()=>{if(root.classList.contains('hidden'))root.style.display='none'},180)}
    function show(){root.style.display='grid';requestAnimationFrame(()=>root.classList.remove('hidden'))}
    function send(action){const frameEl=opts&&opts.frame;if(frameEl&&frameEl.contentWindow)frameEl.contentWindow.postMessage({type:'medsi:tutor-shell',action:'navigate',target:action},'*')}
    root.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const action=b.dataset.action||'';
      if(action==='chat'&&opts&&typeof opts.openCachedChat==='function'&&opts.openCachedChat()){hide();return}
      if(ready){send(action);hide()}else{pending=action}
    });
    return {show,hide,setReady(v){ready=!!v;if(ready&&pending){const a=pending;pending='';send(a);hide()}},destroy(){root.remove()}};
  }
  window.MedsiTutorStartShell={mount};
})();
