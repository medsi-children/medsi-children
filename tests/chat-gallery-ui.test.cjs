const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=pathName=>fs.readFileSync(path.join(__dirname,'..',pathName),'utf8');
test('browser and server use one compact five-media gallery payload',()=>{
  const window={},context={window};
  vm.runInNewContext(read('chat-overlay/gallery-ui.js'),context);
  const items=Array.from({length:5},(_,i)=>({
    fileId:'s3:chat/'+String(i+1).repeat(64)+'.jpg',
    type:i%2?'video':'image'
  }));
  const encoded=window.MedsiChatGallery.pack(items);
  assert.ok(encoded.startsWith('gallery:'));
  assert.equal(window.MedsiChatGallery.parse(encoded).length,5);
  assert.throws(()=>window.MedsiChatGallery.pack(items.slice(0,1)));
  assert.throws(()=>window.MedsiChatGallery.pack([...items,items[0]]));
});
test('both chat clients load shared gallery and can upload five files',()=>{
  const tutor=read('tutors.html'),parent=read('index.html');
  const educator=read('chat-overlay/educator-chat.js'),chat=read('parents/chat-screen.js');
  assert.match(tutor,/gallery-ui\.js\?v=20261117-1/);
  assert.match(tutor,/gallery-ui\.css\?v=20261117-1/);
  assert.match(parent,/gallery-ui\.js\?v=20261117-1/);
  assert.match(parent,/gallery-ui\.css\?v=20261117-1/);
  assert.match(parent,/id="parentChatFile"[^>]*multiple/);
  assert.match(educator,/fileInput\.multiple=true/);
  assert.match(educator,/MedsiChatGallery\.pack\(uploaded\)/);
  assert.match(chat,/MedsiChatGallery\.pack\(uploaded\)/);
  assert.match(chat,/MedsiChatGallery\.render\(m\.fileId,t\)/);
  assert.match(educator,/MedsiChatGallery\.render\(m\.fileId,window\.MedsiOverlayTransport\)/);
});
