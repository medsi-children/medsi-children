(function(){
  if(window.MedsiMenuTwemoji)return;
  window.MedsiMenuTwemoji=true;

  const BASE='/chat-overlay/assets/twemoji/';
  const ITEMS=[
    ['#btnChat .menu-card-title','💬','1f4ac.svg'],
    ['#doctorPatients .menu-card-title','📋','1f4cb.svg'],
    ['#doctorReports .menu-card-title','🧒','1f9d2.svg'],
    ['#screenChoose #medsiParentDirectoryCard .menu-card-title','👥','1f465.svg'],
    ['#btnParentChats .menu-card-title','💬','1f4ac.svg'],
    ['#btnMorning .menu-card-title','☀️','2600.svg'],
    ['#btnEvening .menu-card-title','🌙','1f319.svg'],
    ['#btnPsychology .menu-card-title','🧠','1f9e0.svg'],
    ['#btnSchedule .menu-card-title','🕘','1f558.svg'],
    ['#btnParentPhones .menu-card-title','📞','1f4de.svg']
  ];

  function injectStyles(){
    if(document.getElementById('medsi-menu-twemoji-style'))return;
    const style=document.createElement('style');
    style.id='medsi-menu-twemoji-style';
    style.textContent=`
      .menu-card-title .medsi-menu-twemoji{
        width:1.08em;height:1.08em;display:inline-block;object-fit:contain;
        margin-right:.26em;vertical-align:-.12em;pointer-events:none;user-select:none;-webkit-user-drag:none
      }
      /* The Twemoji speech balloon is fairly dark. On both teal chat cards,
         use it as a clean white pictogram so it reads like the title text. */
      #btnChat .menu-card-title .medsi-menu-twemoji,
      #btnParentChats .menu-card-title .medsi-menu-twemoji{
        filter:brightness(0) invert(1) drop-shadow(0 1px 1px rgba(17,66,74,.12));
        opacity:.80;
      }
      /* Phones card uses the same idea, but tinted to a vivid violet that
         harmonizes with the card instead of turning the icon white. */
      #btnParentPhones .menu-card-title .medsi-menu-twemoji{
        filter:brightness(0) saturate(100%) invert(43%) sepia(35%) saturate(1478%) hue-rotate(218deg) brightness(96%) contrast(94%) drop-shadow(0 1px 1px rgba(63,45,110,.10));
        opacity:.98;
      }
    `;
    document.head.appendChild(style);
  }

  // Warm the same-origin icons used by the current menu.
  [...new Set(ITEMS.filter(item=>document.querySelector(item[0])).map(item=>item[2]))].forEach(file=>{const img=new Image();img.decoding='async';img.src=BASE+file});

  function paintOne(selector,emoji,file){
    const title=document.querySelector(selector);
    if(!title||title.dataset.medsiMenuTwemoji)return;
    const original=String(title.textContent||'');
    const trimmed=original.trimStart();
    if(!trimmed.startsWith(emoji))return;
    const text=trimmed.slice(emoji.length).trimStart();
    const img=document.createElement('img');
    img.className='medsi-menu-twemoji';
    img.src=BASE+file;
    img.alt='';img.setAttribute('aria-hidden','true');
    img.onerror=()=>{title.textContent=original;title.dataset.medsiMenuTwemoji='fallback'};
    title.replaceChildren(img,document.createTextNode(text));
    title.dataset.medsiMenuTwemoji='1';
  }

  function scan(){ITEMS.forEach(item=>paintOne(...item))}
  injectStyles();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',scan,{once:true});else scan();
  new MutationObserver(scan).observe(document.documentElement,{childList:true,subtree:true});
})();
