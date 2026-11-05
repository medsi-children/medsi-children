const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
test('roster is available and phone/new-message screens cannot delete a profile',()=>{
  const html=read('tutors/next-settings.js'),phones=read('tutors/full-web.js'),newChat=read('chat-overlay/educator-new-chat.js');
  assert.match(html,/id="medsiTabRoster"/);
  assert.match(html,/id="medsiRosterPane"/);
  assert.match(html,/\/lab\/admin\/roster\/edit/);
  assert.doesNotMatch(phones,/card\.append\(title,del,meta,actions\)/);
  assert.doesNotMatch(newChat,/card\.append\(name,del,info\)/);
});
