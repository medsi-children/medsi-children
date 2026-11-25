const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=pathName=>fs.readFileSync(path.join(__dirname,'..',pathName),'utf8');
test('browser and server use one compact ten-media gallery payload',()=>{
  const window={},context={window};
  vm.runInNewContext(read('chat-overlay/gallery-ui.js'),context);
  const items=Array.from({length:10},(_,i)=>({
    fileId:'s3:chat/'+String(i+1).repeat(64)+'.jpg',
    type:i%2?'video':'image'
  }));
  const encoded=window.MedsiChatGallery.pack(items);
  assert.ok(encoded.startsWith('gallery:'));
  assert.equal(window.MedsiChatGallery.parse(encoded).length,10);
  assert.throws(()=>window.MedsiChatGallery.pack(items.slice(0,1)));
  assert.throws(()=>window.MedsiChatGallery.pack([...items,items[0]]));
});
test('both chat clients load shared gallery and can upload ten files',()=>{
  const tutor=read('tutors.html'),parent=read('index.html');
  const educator=read('chat-overlay/educator-chat.js'),chat=read('parents/chat-screen.js');
  assert.match(tutor,/gallery-ui\.js\?v=20261125-spinner-1/);
  assert.match(tutor,/gallery-ui\.css\?v=20261125-spinner-1/);
  assert.match(parent,/gallery-ui\.js\?v=20261125-spinner-1/);
  assert.match(parent,/gallery-ui\.css\?v=20261125-spinner-1/);
  assert.match(parent,/id="parentChatFile"[^>]*multiple/);
  assert.match(educator,/fileInput\.multiple=true/);
  assert.match(educator,/MedsiChatGallery\.pack\(uploaded\)/);
  assert.match(chat,/MedsiChatGallery\.pack\(uploaded\)/);
  assert.match(chat,/MedsiChatGallery\.render\(m\.fileId,t\)/);
  assert.match(educator,/MedsiChatGallery\.render\(m\.fileId,window\.MedsiOverlayTransport\)/);
});


test('image gallery uses accessible spinner only during loading and retains failure retry',()=>{
  const js=read('chat-overlay/gallery-ui.js');
  const css=read('chat-overlay/gallery-ui.css');
  assert.doesNotMatch(js,/textContent='Загрузка…'/);
  assert.match(js,/const setLoading=\(\)=>/);
  assert.match(js,/const tileLoading=\(\)=>/);
  assert.match(js,/className='medsi-gallery-spinner'/);
  assert.match(js,/setAttribute\('aria-label','Загрузка вложения'\)/);
  assert.match(js,/status\.onclick=\(\)=>\{setLoading\(\);medium\.src=url;\}/);
  assert.match(js,/Не удалось загрузить\. Повторить/);
  assert.match(js,/Открыть фото/);
  assert.match(css,/\.medsi-gallery-spinner\{[^}]*animation:medsiGallerySpin/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/\.medsi-gallery-load-status\.is-error/);
  // No flickering textual badges on every photo before it has loaded.
  assert.match(js,/if\(item\.type==='image'\)\{tileLoading\(\);btn\.append\(note\);\}/);
});

test('gallery uses visual spinners instead of text loading overlays and preserves retry states',()=>{
  const script=read('chat-overlay/gallery-ui.js');
  const css=read('chat-overlay/gallery-ui.css');
  assert.match(script,/medsi-gallery-spinner/);
  assert.doesNotMatch(script,/textContent='Загрузка…'/);
  assert.match(script,/medium\.onerror=setError/);
  assert.match(script,/status\.onclick=\(\)=>\{setLoading\(\);medium\.src=url;\}/);
  assert.match(script,/tileError/);
  assert.match(css,/@keyframes medsiGallerySpin/);
  assert.match(css,/\.medsi-gallery-load-status\.is-error/);
});
