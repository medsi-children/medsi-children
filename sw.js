self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Keep only an opaque conversation tag and the newest message timestamp.
// iOS may deliver an older encrypted Web Push after a newer one; the saved
// order guard survives service worker restarts and notification dismissal.
function rememberLatestChatPush(tag,at){
  return new Promise(resolve=>{
    if(!self.indexedDB){resolve(true);return;}
    let request,done=false;
    const finish=allowed=>{if(done)return;done=true;resolve(allowed)};
    try{request=self.indexedDB.open('medsi-push-order-v1',1)}
    catch(_){finish(true);return}
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains('threads'))
        request.result.createObjectStore('threads');
    };
    request.onerror=()=>finish(true);
    request.onsuccess=()=>{
      const db=request.result;
      let tx;
      try{tx=db.transaction('threads','readwrite')}
      catch(_){db.close();finish(true);return}
      let allowed=true;
      const store=tx.objectStore('threads');
      const previous=store.get(tag);
      previous.onsuccess=()=>{
        if(Number(previous.result||0)>at){allowed=false;return;}
        store.put(at,tag);
      };
      previous.onerror=()=>{allowed=true};
      tx.oncomplete=()=>{db.close();finish(allowed)};
      tx.onerror=()=>{db.close();finish(true)};
      tx.onabort=()=>{db.close();finish(true)};
    };
  });
}

self.addEventListener('push', event => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = {
      title: 'Медси Бот',
      body: event.data ? event.data.text() : 'Новое уведомление'
    };
  }

  if (!payload || typeof payload !== 'object') return;

  if (payload.action === 'close-notification') {
    event.waitUntil(
      self.registration.getNotifications({ tag: payload.tag || 'medsi-message' })
        .then(items => items.forEach(item => item.close()))
    );
    return;
  }

  if (typeof payload.body !== 'string' || !payload.body.trim()) return;

  const title = payload.title || 'Медси Бот';
  const options = {
    body: payload.body || 'Новое сообщение',
    icon: payload.icon || '/apple-touch-icon.png',
    badge: payload.badge || '/apple-touch-icon.png',
    tag: payload.tag || 'medsi-message',
    // A new message in the same chat replaces its older preview.
    // With a stable tag, a newer notification should still be announced.
    renotify: false,
    silent: false,
    timestamp: Date.now(),
    data: {
      url: payload.url || '/'
    }
  };

  const orderedChat=payload.type==='chat'&&
    /^medsi-chat-[a-f0-9]{20}$/.test(String(payload.tag||''))&&
    Number.isSafeInteger(payload.messageAt)&&payload.messageAt>0;
  if(!orderedChat){
    event.waitUntil(self.registration.showNotification(title,options));
    return;
  }
  options.renotify=true;
  options.timestamp=payload.messageAt;
  options.data.messageAt=payload.messageAt;
  event.waitUntil((async()=>{
    if(!await rememberLatestChatPush(options.tag,payload.messageAt))return;
    // Fallback for browsers that cannot persist IndexedDB in a service worker.
    let visible=[];
    try{visible=await self.registration.getNotifications({tag:options.tag})}
    catch(_){}
    if(visible.some(item=>Number(item?.data?.messageAt||0)>payload.messageAt))return;
    await self.registration.showNotification(title,options);
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  const notificationData = event.notification.data || {};
  const targetUrl = new URL(
    notificationData && notificationData.url
      ? notificationData.url
      : '/',
    self.location.origin
  ).href;
  function normalizePanelPath(path) {
    const value = String(path || '/');
    if (value === '/tutors.html') return '/tutors';
    return value;
  }

  const targetPath = normalizePanelPath(new URL(targetUrl).pathname);

  event.waitUntil((async () => {
    const clientsList = await clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clientsList) {
      const clientPath = normalizePanelPath(new URL(client.url || '/', self.location.origin).pathname);
      if (clientPath === targetPath && 'focus' in client) {
        await client.focus();
        return;
      }
    }

    if (clients.openWindow) {
      await clients.openWindow(targetUrl);
    }
  })());
});
