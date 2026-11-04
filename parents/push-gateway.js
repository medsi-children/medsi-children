(function(){
  'use strict';
  // Web Push now uses the current Timeweb origin directly. Do not monkey-patch
  // global fetch or preserve a fallback to the retired Cloudflare worker.
  function syncPushPanel(){
    if(!window.MedsiPush)return;
    window.MedsiPush.setPanelVisible(document.body.dataset.screen==='screenChoose');
  }
  new MutationObserver(syncPushPanel).observe(document.body,{
    attributes:true,attributeFilter:['data-screen']
  });
  syncPushPanel();
})();
