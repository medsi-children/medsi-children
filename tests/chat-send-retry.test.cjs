const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'chat-overlay', 'transport.js'), 'utf8');

function transport(fetch, provider) {
  const window = { location: { origin: 'https://example.test' } };
  if (provider) window.MedsiEducatorSession = provider;
  const document = {
    getElementById: () => null,
    createElement: () => ({}),
    querySelectorAll: () => [],
    addEventListener: () => {},
    documentElement: {},
    head: { appendChild: () => {} }
  };
  class MutationObserver { observe() {} }
  vm.runInNewContext(source, {
    window, document, fetch, MutationObserver, AbortController, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'one-send-id' }
  });
  return window.MedsiOverlayTransport;
}

test('educator reads use the current session even when an open screen holds an older one', async () => {
  const keys=[];
  const chat=transport(async(_url,options)=>{keys.push(options.headers['X-Medsi-Chat-Session']);return {ok:true,status:200,json:async()=>({ok:true,parents:[]})}},
    {get:async()=>({token:'current-key'}),renew:async()=>{throw new Error('Unexpected renewal')}});
  await chat.parents({token:'old-screen-key',expiresAt:1});
  assert.deepEqual(keys,['current-key']);
});

test('a rejected educator key is renewed once and the same operation is retried', async () => {
  const keys=[],ids=[];let renewals=0;
  const chat=transport(async(_url,options)=>{
    keys.push(options.headers['X-Medsi-Chat-Session']);ids.push(JSON.parse(options.body).clientMessageId);
    return keys.length===1?{ok:false,status:401,json:async()=>({ok:false,code:'SESSION_EXPIRED'})}
      :{ok:true,status:200,json:async()=>({ok:true})};
  },{get:async()=>({token:'rejected'}),renew:async token=>{assert.equal(token,'rejected');renewals++;return {token:'renewed'}}});
  await chat.sendMessage({token:'old-screen-key'},'educator','0000000000',{type:'text',text:'Synthetic'});
  assert.deepEqual(keys,['rejected','renewed']);assert.equal(renewals,1);assert.equal(ids[0],ids[1]);
});

test('an unavailable educator authorization never causes an endless renewal loop', async () => {
  let renewals=0,calls=0;
  const chat=transport(async()=>{calls++;return {ok:false,status:401,json:async()=>({ok:false,message:'Denied'})}},
    {get:async()=>({token:'rejected'}),renew:async()=>{renewals++;return {token:'still-rejected'}}});
  await assert.rejects(chat.parents({token:'old'}),/Denied/);
  assert.equal(renewals,1);assert.equal(calls,2);
});

test('simultaneous educator session renewals share one authorization request', async () => {
  const full=fs.readFileSync(path.join(__dirname,'..','tutors','full-web.js'),'utf8');
  const helper=full.slice(full.indexOf('  function requestFreshD1()'),full.indexOf('  function scheduleD1Warm()'));
  let calls=0,resolve;
  const context={callApi:async()=>{calls++;return new Promise(r=>{resolve=r})},extractD1:x=>x.d1Session,saveAuth(){},tutorToken:'synthetic',d1RefreshPromise:null};
  vm.runInNewContext(helper+';globalThis.renew=requestFreshD1;',context);
  const first=context.renew(),second=context.renew();
  assert.equal(first,second);assert.equal(calls,1);
  resolve({d1Session:{token:'renewed'}});await Promise.all([first,second]);
});

test('only educator text receives conservative punctuation spacing', async () => {
  const requests = [];
  const chat = transport(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const raw = 'Первое , второе. Третье ,четвёртое\nПятое .Шестое ( интересное )';
  const fixed = 'Первое, второе. Третье, четвёртое\nПятое. Шестое (интересное)';
  assert.equal(chat.normalizeEducatorText(raw), fixed);
  assert.equal(chat.normalizeEducatorText(fixed), fixed);
  for (const sample of ['Первое , Второе', 'Первое ,Второе', 'Первое,Второе', 'Первое . Второе', 'Первое .Второе', 'Первое.Второе']) {
    assert.equal(chat.normalizeEducatorText(sample), sample.includes(',') ? 'Первое, Второе' : 'Первое. Второе');
  }
  assert.equal(chat.normalizeEducatorText('Книжки ( интересные), раскраски ( милые ) и (  вложенные ( детали )  ).'),
    'Книжки (интересные), раскраски (милые) и (вложенные (детали)).');
  assert.equal(chat.normalizeEducatorText('Ссылка: https://example.test/(путь) и строка ( \nтекст\n)'),
    'Ссылка: https://example.test/(путь) и строка (\nтекст\n)');
  assert.equal(chat.normalizeEducatorText('В 17:00, 09.10.2026 — 3.14 и 1,5; т.д. А.С. https://example.test/путь,текст'),
    'В 17:00, 09.10.2026 — 3.14 и 1,5; т.д. А.С. https://example.test/путь,текст');

  await chat.sendMessage({ token: 'session' }, 'educator', '9991112233', { type: 'text', text: raw });
  await chat.sendMessage({ token: 'session' }, 'parent', '9991112233', { type: 'text', text: raw });
  await chat.sendMessage({ token: 'session' }, 'educator', '9991112233', { type: 'video', text: raw, fileId: 'video-id' });
  await chat.edit({ token: 'session' }, 'educator', 'message-1', raw);
  await chat.edit({ token: 'session' }, 'parent', 'message-2', raw);
  assert.deepEqual(requests.map(request => request.text), [fixed, raw, raw, fixed, raw]);
});

test('a lost send response retries the same message id', async () => {
  const requests = [];
  const chat = transport(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new TypeError('VPN disconnected');
    return { ok: true, status: 200, json: async () => ({ ok: true, message: { messageKey: 'saved' } }) };
  });
  const result = await chat.sendMessage({ token: 'session' }, 'parent', '9991112233', { type: 'text', text: 'Привет' });
  assert.equal(result.message.messageKey, 'saved');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].clientMessageId, 'one-send-id');
  assert.deepEqual(requests[0], requests[1]);
});

test('an access denial is not retried', async () => {
  let calls = 0;
  const chat = transport(async () => {
    calls += 1;
    return { ok: false, status: 403, json: async () => ({ ok: false, message: 'Forbidden' }) };
  });
  await assert.rejects(chat.sendMessage({ token: 'session' }, 'parent', '9991112233', { type: 'text', text: 'Привет' }), /Forbidden/);
  assert.equal(calls, 1);
});

test('a temporary Timeweb gateway error gets one more attempt', async () => {
  let calls = 0;
  const chat = transport(async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 502, json: async () => ({ ok: false, code: 'UPSTREAM_UNAVAILABLE' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, message: { messageKey: 'saved' } }) };
  });
  const result = await chat.sendMessage({ token: 'session' }, 'parent', '9991112233', { type: 'text', text: 'Привет' });
  assert.equal(result.message.messageKey, 'saved');
  assert.equal(calls, 2);
});

test('other writes remain single-attempt operations', async () => {
  let calls = 0;
  const chat = transport(async () => { calls += 1; throw new TypeError('network failed'); });
  await assert.rejects(chat.markRead({ token: 'session' }, 'parent', '9991112233'));
  assert.equal(calls, 1);
});

test('a lost report receipt retries the identical report and submission id', async () => {
  const requests=[];
  const chat=transport(async(_url,options)=>{
    const payload=JSON.parse(options.body);requests.push(payload);
    if(requests.length===1)throw new TypeError('VPN disconnected after save');
    return {ok:true,status:200,json:async()=>({ok:true,accepted:true,submissionId:payload.submissionId})};
  });
  const payload={reportType:'morning',text:'Лена — Синтетический текст.',submissionId:'report_synthetic_retry'};
  const receipt=await chat.reportSubmit({token:'session'},payload);
  assert.equal(receipt.submissionId,payload.submissionId);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0],requests[1]);
});


test('psychologist single-attempt report write does not silently resend through a second route', async () => {
  const requests=[];
  const chat=transport(async (url, options) => {
    requests.push({url,body:JSON.parse(options.body)});
    throw new TypeError('VPN disconnected');
  });
  const payload={reportType:'psychology',text:'Вымышленный текст.',submissionId:'report_one_timeweb_123'};
  await assert.rejects(chat.reportSubmit({token:'session'},payload,{retryTransientWrite:false}));
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://example.test/lab/report-submit');
  assert.equal(requests[0].body.submissionId,payload.submissionId);
});
