(function(){
  if(window.MedsiComposerUI)return;
  const ICONS={
    plus:'<svg class="medsi-compose-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    send:'<svg class="medsi-compose-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back:'<svg class="medsi-nav-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    phone:'<svg class="medsi-phone-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 4.2 9.5 8.5 7.6 10.4c1.3 2.6 3.4 4.7 6 6l1.9-1.9 4.3 2.3c.5.3.8.9.6 1.5l-.5 2.1c-.2.7-.8 1.1-1.5 1.1C9.7 21.5 2.5 14.3 2.5 5.6c0-.7.4-1.3 1.1-1.5l2.1-.5c.6-.1 1.2.1 1.5.6Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  function setIcon(el,name){if(!el||!ICONS[name]||el.dataset.medsiIcon===name)return;el.dataset.medsiIcon=name;el.innerHTML=ICONS[name]}
  function autoGrow(el,min,max){if(!el)return;el.style.setProperty('height','0px','important');const next=Math.max(min,Math.min(max,el.scrollHeight||min));el.style.setProperty('height',next+'px','important')}
  function installParent(){
    const compose=document.getElementById('parentChatCompose');if(!compose)return false;
    const attach=document.getElementById('parentChatAttach'),send=document.getElementById('parentChatSend'),back=document.getElementById('parentChatBack'),input=document.getElementById('parentChatInput');
    if(attach){attach.setAttribute('aria-label','Прикрепить фото или видео');attach.title='Прикрепить фото или видео';setIcon(attach,'plus')}
    if(send){send.setAttribute('aria-label','Отправить сообщение');setIcon(send,'send')}
    if(back){back.setAttribute('aria-label','Назад');setIcon(back,'back')}
    if(input&&!input.dataset.medsiAutoGrow){input.dataset.medsiAutoGrow='1';const grow=()=>autoGrow(input,48,120);input.addEventListener('input',grow);compose.addEventListener('submit',()=>setTimeout(grow,0));grow()}
    compose.dataset.medsiComposerUi='1';return true;
  }
  function phoneHrefFromHeader(header){const match=String(header&&header.textContent||'').match(/(?:Номер телефона|Телефон):\s*([+\d][\d\s()+-]*)/i);const digits=String(match&&match[1]||'').replace(/\D+/g,'').slice(-10);return digits.length===10?'tel:+7'+digits:''}
  function ensureCallButton(top,header){let call=top.querySelector('.medsi-tutor-call');if(!call){call=document.createElement('a');call.className='medsi-tutor-call';call.setAttribute('aria-label','Позвонить родителю');call.title='Позвонить родителю';top.appendChild(call)}setIcon(call,'phone');const href=phoneHrefFromHeader(header);if(href){call.href=href;call.removeAttribute('aria-disabled');call.style.visibility='visible'}else{call.removeAttribute('href');call.setAttribute('aria-disabled','true');call.style.visibility='hidden'}return call}
  function installTutor(){
    const screen=document.getElementById('screenChatThread'),header=document.getElementById('chatThreadHeader'),back=document.getElementById('btnThreadBack'),compose=screen&&screen.querySelector('.chat-compose'),editorWrap=document.getElementById('chatReplyEditor'),editor=document.getElementById('chatReplyInput'),quick=document.getElementById('btnQuickReplies'),quickPanel=document.getElementById('quickRepliesPanel'),doctors=document.getElementById('doctorButtons'),attach=document.getElementById('chatAttachBtn'),send=document.getElementById('chatReplySendBtn'),video=document.getElementById('btnVideo');
    if(!screen||!header||!back||!compose||!editorWrap||!editor||!quick)return false;
    let top=screen.querySelector(':scope > .medsi-chat-thread-top');if(!top){top=document.createElement('div');top.className='medsi-chat-thread-top';screen.insertBefore(top,header)}
    if(back.parentNode!==top)top.insertBefore(back,top.firstChild);if(header.parentNode!==top)top.appendChild(header);ensureCallButton(top,header);if(quick.parentNode!==editorWrap)editorWrap.appendChild(quick);
    if(video)video.classList.add('medsi-composer-redundant');if(attach){attach.setAttribute('aria-label','Прикрепить фото или видео');attach.title='Прикрепить фото или видео';setIcon(attach,'plus')}if(send){send.setAttribute('aria-label','Отправить сообщение');setIcon(send,'send')}back.setAttribute('aria-label','Назад');setIcon(back,'back');quick.setAttribute('aria-label','Быстрые ответы');quick.title='Быстрые ответы';
    if(!editor.dataset.medsiAutoGrow){editor.dataset.medsiAutoGrow='1';const grow=()=>autoGrow(editor,46,134);editor.addEventListener('input',grow);new MutationObserver(()=>requestAnimationFrame(grow)).observe(editor,{childList:true,subtree:true,characterData:true});grow()}
    if(quickPanel&&!quickPanel.dataset.medsiComposerUi){quickPanel.dataset.medsiComposerUi='1';quickPanel.addEventListener('click',e=>{const chosen=e.target&&e.target.closest&&e.target.closest('.quick-btn:not(.quick-doctors),.quick-doctor-btn');if(chosen){quickPanel.classList.add('hidden');if(doctors)doctors.classList.add('hidden');setTimeout(()=>autoGrow(editor,46,134),0)}});quick.addEventListener('click',()=>{if(quickPanel.classList.contains('hidden')&&doctors)doctors.classList.add('hidden')})}
    screen.classList.add('medsi-composer-ready');compose.dataset.medsiComposerUi='1';return true;
  }
  let scheduled=false;function install(){scheduled=false;installParent();installTutor()}function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(install)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});
  window.MedsiComposerUI={install};
})();
