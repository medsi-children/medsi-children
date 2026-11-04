(function(){
  'use strict';
  if(window.__medsiTimewebSessionClient)return;
  window.__medsiTimewebSessionClient=true;
  const nativeFetch=window.fetch.bind(window);
  const RETIRED=/^(?:script\.google\.com|script\.googleusercontent\.com|(?:[a-z0-9-]+\.)+workers\.dev|drive\.google\.com)$/i;
  window.fetch=function(input,init){
    try{
      const raw=typeof input==='string'?input:String(input&&input.url||'');
      const url=new URL(raw,window.location?.href||'https://medsi.invalid/');
      // Prevent old cached modules from silently contacting retired
      // Apps Script/Cloudflare/Drive endpoints with signed or clinical data.
      if((RETIRED.test(url.hostname)&&(
          url.hostname.includes('workers.dev') ||
          url.hostname.startsWith('script.google') ||
          (url.hostname==='drive.google.com'&&url.pathname.startsWith('/thumbnail'))
      ))) {
        return Promise.reject(new Error('LEGACY_UPSTREAM_DISABLED'));
      }
    }catch(_){/* malformed URLs remain the browser's responsibility */}
    return nativeFetch(input,init);
  };
})();
