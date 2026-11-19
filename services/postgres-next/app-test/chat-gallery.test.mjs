import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatGallery,parseChatGallery} from '../app/chat-gallery.mjs';
const images=Array.from({length:10},(_,i)=>({
  fileId:'s3:chat/'+String(i+1).repeat(64)+'.jpg',
  type:i===3?'video':'image'
}));
test('a group of two to ten distinct S3 objects travels as one message',()=>{
  for(let count=2;count<=10;count++){
    const packed=createChatGallery(images.slice(0,count));
    assert.deepEqual(parseChatGallery(packed),images.slice(0,count));
    assert.ok(packed.length<2400);
  }
});
test('rejects forged foreign paths, invalid media types and oversized galleries',()=>{
  assert.equal(parseChatGallery('gallery:invalid'),null);
  assert.equal(parseChatGallery('gallery:'+JSON.stringify(images.slice(0,1))),null);
  assert.equal(parseChatGallery('gallery:'+JSON.stringify([...images,images[0]])),null);
  assert.equal(parseChatGallery('gallery:'+JSON.stringify([images[0],images[0]])),null);
  assert.equal(parseChatGallery('gallery:'+JSON.stringify([images[0],{fileId:'s3:../private',type:'image'}])),null);
  assert.equal(parseChatGallery('gallery:'+JSON.stringify([images[0],{...images[1],type:'audio'}])),null);
});
