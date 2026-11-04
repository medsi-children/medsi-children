import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Prevent the next Timeweb release from reintroducing outbound requests to
// retired Apps Script / Cloudflare / Google Drive data paths.
// Legacy server.js is intentionally still present for safe pre-cutover rollback,
// but the NEXT branch must never call it or direct clients to it.
const ROOT = new URL('../', import.meta.url);
const candidates = [
  'index.html','tutors.html','psychology.html','notify-client.js','sw.js'
];
for (const dir of ['parents','tutors','chat-overlay','psychology']) {
  for (const file of readdirSync(new URL(dir+'/', ROOT))) {
    if (/\.(?:js|html)$/.test(file)) candidates.push(dir+'/'+file);
  }
}
const errors=[];
const forbidden = /(?:script\.google(?:usercontent)?\.com|(?:[a-z0-9-]+\.)?workers\.dev|drive\.google\.com\/thumbnail|\/__session\/apps-script)/gi;
for (const file of candidates) {
  const source=readFileSync(new URL(file,ROOT),'utf8');
  if(file==='chat-overlay/session-client.js') {
    // This is a deny-only compatibility guard; it rejects retired destinations
    // for clients with older cached scripts. It is not a network redirect.
    if(!source.includes('LEGACY_UPSTREAM_DISABLED')||
      !source.includes('Promise.reject')||
      !source.includes('nativeFetch(input,init)'))errors.push('retired URL guard missing');
    continue;
  }
  for (const match of source.matchAll(forbidden)) {
    errors.push(file+' contains retired endpoint: '+match[0]);
  }
}
const server=readFileSync(new URL('server.js',ROOT),'utf8');
const branch=server.split('} else {')[0];
if (!branch.includes("MEDSI_NEXT_STAND === '1'") ||
    !branch.includes("MEDSI_NEXT_PG_ENABLED === '1'") ||
    !branch.includes('services/postgres-next/src/connection.mjs') ||
    /\.workers\.dev|script\.google\.com\/macros/.test(branch)) {
  errors.push('NEXT bootstrap is not isolated from legacy services');
}
const next=readFileSync(new URL('services/ydb-next/src/stand-server.mjs',ROOT),'utf8');
for(const must of [
  "app.post(['/__session/api','/__session/apps-script']",
  "app.use('/lab'",
  "app.use('/push'",
  "app.post('/chat-upload'",
  "app.get('/media/s3/:key'",
  "app.get('/__health'"
]){
  if(!next.includes(must))errors.push('missing same-origin backend route: '+must);
}
if (/fetch\(['"]https?:\/\/|\.workers\.dev|script\.google\.com\/macros/.test(next)) {
  errors.push('NEXT backend contains external legacy network dependency');
}
const router=readFileSync(new URL('services/ydb-next/src/api-router.mjs',ROOT),'utf8');
for(const must of [
  "router.post('/parent-registration'",
  "router.post('/parent-auth/request'",
  "router.post('/report-submit'",
  "router.get('/report-submit/status'",
  "router.get('/admin/reports/dashboard'",
  "router.post('/messages'",
  "router.post('/parent-delete'"
]){
  if(!router.includes(must))errors.push('missing NEXT application operation: '+must);
}
if(errors.length) {
  console.error('MEDSI_NEXT_LEGACY_ROUTE_AUDIT_FAILED');
  for(const problem of errors)console.error(problem);
  process.exitCode=1;
}else{
  console.log('MEDSI_NEXT_LEGACY_ROUTE_AUDIT_OK files='+candidates.length);
}
