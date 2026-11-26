(function(){
  if(window.MedsiGestureNavigation)return;

  const EDGE_PX=38;
  const MIN_X=68;
  const MAX_MS=1150;
  let gesture=null;

  function injectTouchups(){
    if(document.getElementById('medsi-gesture-navigation-style'))return;
    const style=document.createElement('style');
    style.id='medsi-gesture-navigation-style';
    style.textContent=`
      /* Parent composer circles need a tiny optical lift on iOS. */
      #parentChatCompose #parentChatAttach,
      #parentChatCompose #parentChatSend{top:-2px!important}

      /* Quick replies keep the same tap target but visually become only quiet grey lines. */
      .educator-exact-clone #btnQuickReplies{
        border:0!important;background:transparent!important;box-shadow:none!important;color:#a0a9b3!important;
      }
      .educator-exact-clone #btnQuickReplies::before{
        content:''!important;display:block!important;width:16px!important;height:12px!important;
        background:
          linear-gradient(#a0a9b3,#a0a9b3) 0 0/16px 2px no-repeat,
          linear-gradient(#a0a9b3,#a0a9b3) 0 5px/16px 2px no-repeat,
          linear-gradient(#a0a9b3,#a0a9b3) 0 10px/16px 2px no-repeat!important;
        border-radius:1px!important;
      }

      /* Date chips are inserted after the transport row is matched. Reveal them quietly instead of popping in. */
      .medsi-date-separator{animation:medsiDateChipIn .18s cubic-bezier(.22,.7,.3,1) both}
      @keyframes medsiDateChipIn{
        from{opacity:0;transform:translateY(3px) scale(.985)}
        to{opacity:1;transform:none}
      }

      /* Lightweight swipe-back affordance: only the hint follows the finger, never the whole screen. */
      .medsi-swipe-back-hint{
        position:fixed;z-index:25000;left:8px;width:38px;height:38px;border-radius:999px;
        display:grid;place-items:center;pointer-events:none;opacity:0;
        color:#16b8c0;background:rgba(249,254,254,.96);border:1.5px solid rgba(22,184,192,.32);
        box-shadow:0 7px 18px rgba(22,184,192,.12),inset 0 1px 0 rgba(255,255,255,.86);
        transform:translate3d(-8px,-50%,0) scale(.86);transform-origin:center;
        transition:opacity .08s linear;will-change:transform,opacity;
      }
      .medsi-swipe-back-hint svg{
        width:19px;height:19px;display:block;fill:none;stroke:currentColor;stroke-width:2.35;
        stroke-linecap:round;stroke-linejoin:round;
      }
      @media(prefers-reduced-motion:reduce){
        .medsi-date-separator{animation:none!important}
        .medsi-swipe-back-hint{transition:none!important}
      }
    `;
    document.head.appendChild(style);
  }

  function visibleModal(){
    return !!document.querySelector('.link-modal-overlay:not(.hidden),.parent-chat-lightbox:not(.hidden),.overlay-image-viewer.is-open');
  }

  function click(el){
    if(!el||el.disabled)return false;
    el.click();
    return true;
  }

  function tutorOverlayBack(screen){
    if(screen==='screenChatThread')return click(document.getElementById('btnThreadBack'));
    if(screen==='screenNewChat')return click(document.getElementById('btnParentsBack'));
    if(screen==='screenChats')return click(document.getElementById('btnChatsBack'));
    return false;
  }

  function tutorMainBack(screen){
    if(/^report-/.test(screen))return click(document.getElementById('btnBack'));
    if(screen==='screenPhones')return click(document.getElementById('btnPhonesBack'));
    if(screen==='screenDone')return click(document.getElementById('btnAgain'));
    return false;
  }

  function parentBack(screen){
    if(screen==='screenChat')return click(document.getElementById('parentChatBack'));
    if(screen==='screenReport')return click(document.getElementById('reportBackBtn'));
    if(screen==='screenSchedule')return click(document.getElementById('scheduleBackBtn'));
    if(screen==='screenPhoneReg')return click(document.getElementById('phoneRegBackBtn'));
    if(screen==='screenNames')return click(document.getElementById('namesBackBtn'));
    if(screen==='screenAuth')return click(document.getElementById('authBackBtn'));
    return false;
  }

  function resolveAction(){
    if(visibleModal())return null;
    const screen=String(document.body.dataset.screen||'');

    if(document.getElementById('doctorWorkspace')){
      const modalBack=[
        ['dialog.doctor-date-editor[open]',null],
        ['#medsiParentDirectoryDialog:not(.hidden)','#medsiDirectoryClose'],
        ['#tutorQrModal:not(.hidden)','#tutorQrClose'],
        ['#medsiTutorReportLibrary:not(.hidden)','#medsiReportsBack']
      ];
      for(const [selector,button] of modalBack){
        const modal=document.querySelector(selector);
        if(modal)return button?()=>click(document.querySelector(button)):()=>{modal.close();return true};
      }
      if(['screenPhones','screenTherapy','screenPatients'].includes(screen))
        return()=>click(document.querySelector('#'+screen+(screen==='screenTherapy'&&document.querySelector('#therapyDone:not(.hidden)')?' #therapyAgain':' [data-home]')));
      return null;
    }

    if(document.getElementById('btnParentChats')){
      if(document.body.classList.contains('medsi-chat-overlay-open')||document.querySelector('.educator-exact-clone')){
        if(['screenChatThread','screenChats','screenNewChat'].includes(screen))return()=>tutorOverlayBack(screen);
      }
      if(/^report-/.test(screen)||screen==='screenPhones'||screen==='screenDone')return()=>tutorMainBack(screen);
      return null;
    }

    if(document.getElementById('btnChat')){
      if(['screenChat','screenReport','screenSchedule','screenPhoneReg','screenNames','screenAuth'].includes(screen))return()=>parentBack(screen);
    }
    return null;
  }

  function interactiveStart(target){
    return !!(target&&target.closest&&target.closest('input,textarea,[contenteditable="true"],video,audio'));
  }

  function createHint(y){
    const hint=document.createElement('div');
    hint.className='medsi-swipe-back-hint';
    hint.setAttribute('aria-hidden','true');
    hint.innerHTML='<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>';
    const top=Math.max(52,Math.min(window.innerHeight-52,Number(y)||window.innerHeight/2));
    hint.style.top=top+'px';
    document.body.appendChild(hint);
    return hint;
  }

  function updateHint(current,dx){
    if(!current||!current.hint)return;
    const x=Math.max(0,Math.min(30,dx*.28));
    const progress=Math.max(0,Math.min(1,dx/MIN_X));
    current.hint.style.opacity=String(Math.max(0,Math.min(1,(dx-4)/20)));
    current.hint.style.transform='translate3d('+(-8+x)+'px,-50%,0) scale('+(0.86+0.16*progress)+')';
  }

  function dismissHint(current,commit){
    const hint=current&&current.hint;if(!hint)return;
    hint.style.transition='transform .14s cubic-bezier(.22,.7,.3,1),opacity .14s ease';
    if(commit){
      hint.style.opacity='0';
      hint.style.transform='translate3d(32px,-50%,0) scale(1.08)';
    }else{
      hint.style.opacity='0';
      hint.style.transform='translate3d(-10px,-50%,0) scale(.84)';
    }
    setTimeout(()=>{if(hint.isConnected)hint.remove()},160);
  }

  document.addEventListener('touchstart',e=>{
    gesture=null;
    if(e.touches.length!==1||interactiveStart(e.target))return;
    const action=resolveAction();
    if(!action)return;
    const t=e.touches[0];
    const left=window.visualViewport?window.visualViewport.offsetLeft:0;
    if(t.clientX-left>EDGE_PX)return;
    gesture={action,startX:t.clientX,startY:t.clientY,lastX:t.clientX,lastY:t.clientY,started:Date.now(),valid:true,hint:createHint(t.clientY)};
  },{capture:true,passive:true});

  document.addEventListener('touchmove',e=>{
    if(!gesture||!gesture.valid||e.touches.length!==1)return;
    const t=e.touches[0];
    gesture.lastX=t.clientX;gesture.lastY=t.clientY;
    const dx=t.clientX-gesture.startX,dy=t.clientY-gesture.startY;
    if(dx<0||Math.abs(dy)>Math.max(24,Math.abs(dx)*1.15)){
      gesture.valid=false;
      dismissHint(gesture,false);
      return;
    }
    updateHint(gesture,dx);
  },{capture:true,passive:true});

  document.addEventListener('touchend',e=>{
    if(!gesture)return;
    const current=gesture;gesture=null;
    if(!current.valid)return;
    const t=e.changedTouches&&e.changedTouches[0];
    const endX=t?t.clientX:current.lastX,endY=t?t.clientY:current.lastY;
    const dx=endX-current.startX,dy=endY-current.startY,elapsed=Date.now()-current.started;
    const commit=dx>=MIN_X&&Math.abs(dx)>=Math.abs(dy)*1.35&&elapsed<=MAX_MS;
    dismissHint(current,commit);
    if(!commit)return;

    e.preventDefault();
    e.stopImmediatePropagation();
    requestAnimationFrame(()=>current.action());
  },{capture:true,passive:false});

  document.addEventListener('touchcancel',()=>{
    if(!gesture)return;
    const current=gesture;gesture=null;
    dismissHint(current,false);
  },{capture:true,passive:true});

  injectTouchups();
  window.MedsiGestureNavigation={resolveAction};
})();
