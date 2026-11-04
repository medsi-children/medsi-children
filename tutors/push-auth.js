(function(){
  'use strict';
  const TUTOR_KEY='medsi_tutor_session_v1';
  const nativeFetch=window.fetch.bind(window);
  function tutorToken(){
    try{return String(localStorage.getItem(TUTOR_KEY)||'').trim()}catch(_){return''}
  }
  window.fetch=function(input,init){
    // This compatibility shim only attaches the educator token to same-origin
    // Timeweb push subscription requests. It NEVER redirects to another host.
    try{
      const raw=typeof input==='string'?input:String(input&&input.url||'');
      const url=new URL(raw,window.location.origin);
      if(url.origin===window.location.origin &&
         (url.pathname==='/push/subscribe'||url.pathname==='/push/unsubscribe') &&
         init&&typeof init.body==='string'){
        const body=JSON.parse(init.body);
        if(String(body?.role||'').toLowerCase()==='educator'){
          const token=tutorToken();
          if(token)return nativeFetch(input,{...init,body:JSON.stringify({...body,tutorToken:token})});
        }
      }
    }catch(_){/* leave original request unmodified */}
    return nativeFetch(input,init);
  };
})();
