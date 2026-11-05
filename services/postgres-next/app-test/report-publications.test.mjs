import test from 'node:test';
import assert from 'node:assert/strict';
import { moscowDate, prepareReportPublication, createReportPublicationStore } from '../app/report-publications.mjs';
import {readPostgresConfig} from '../src/connection.mjs';

const now = Date.now();
const recipient = (phone10, admissionId, text) => ({ phone10, admissionId, text });
const sample = (more = {}) => ({
  kind: 'morning',
  submissionId: 'submission_test_001',
  authorId: 'educator_001',
  rawText: 'Ребёнок А: наблюдение',
  normalizedText: 'Ребёнок А: наблюдение',
  submittedAt: now - 120000,
  recipients: [
    recipient('9000000001', 'admission_001', 'Наблюдение А'),
    recipient('9000000002', 'admission_002', 'Наблюдение Б')
  ],
  ...more
});

function fromUInt(value) {
  if (typeof value === 'number' || typeof value === 'bigint') return Number(value);
  if (value && typeof value.value !== 'undefined') return Number(value.value);
  if (value && typeof value._value !== 'undefined') return Number(value._value);
  const str = String(value);
  if (/^\d+$/.test(str)) return Number(str);
  throw new Error('Mock could not decode PostgreSQL integer');
}

function fakeDb(profiles) {
  const state = {
    profiles: profiles.map(x => ({ ...x })),
    submissions: new Map(),
    heads: new Map(),
    current: new Map(),
    raw: new Map(),
    history: new Map(),
    push: new Map(),
    ownership: new Map()
  };
  const writes = [];
  const clone = () => ({
    ...state,
    submissions: new Map(state.submissions), heads: new Map(state.heads),
    current: new Map(state.current), raw: new Map(state.raw),
    history: new Map(state.history), push: new Map(state.push), ownership: new Map(state.ownership)
  });
  const sql = {
    async begin(options, fn) {
      assert.equal(options.isolation, 'serializableReadWrite');
      const snapshot = clone();
      const tx = async (strings, ...values) => {
        const source = strings.join(' ? ').replace(/\s+/g, ' ').trim();
        if(source.includes('FROM raw_reports'))return snapshot.raw.has(values[0])?[[snapshot.raw.get(values[0])]]:[[]];
        if (source.includes('FROM report_submissions')) return snapshot.submissions.has(values[0])
          ? [[snapshot.submissions.get(values[0])]] : [[]];
        if (source.includes('FROM parent_profiles')) return [snapshot.profiles];
        if (source.includes('FROM report_publication_head')) return snapshot.heads.has(values[0])
          ? [[snapshot.heads.get(values[0])]] : [[]];
        if (source.includes('FROM parent_current_reports')) return snapshot.current.has(values[0] + '/' + values[1])
          ? [[snapshot.current.get(values[0] + '/' + values[1])]] : [[]];
        if (source.includes('FROM report_ownership')) return snapshot.ownership.has(values[0])
          ? [[{record_json:snapshot.ownership.get(values[0])}]] : [[]];
        const table = source.match(/^INSERT INTO ([a-z_]+)/)?.[1];
        assert.ok(table, 'unexpected SQL operation ' + source);
        writes.push(table);
        switch (table) {
          case 'report_ownership':
            snapshot.ownership.set(values[0], values[1]);
            break;
          case 'raw_reports':
            snapshot.raw.set(values[0], { kind: values[1], report_date:values[2], raw_text: values[3], normalized_text: values[4] });
            break;
          case 'parent_current_reports':
            snapshot.current.set(values[0] + '/' + values[1], {
              phone10: values[0], admission_id: values[2], publication_id: values[3],
              revision: fromUInt(values[4]), text: values[5], version: values[6],
              read_version: values[7], updated_at:fromUInt(values[8])
            });
            break;
          case 'parent_report_history':
            snapshot.history.set(values[0] + '/' + values[1] + '/' + values[2],
              { admission_id: values[3], publication_id: values[4], text: values[6] });
            break;
          case 'push_outbox':
            snapshot.push.set(values[0], { role: values[1], phone10: values[2], data: JSON.parse(values[3]) });
            break;
          case 'report_submissions':
            snapshot.submissions.set(values[0], {
              kind: values[1], payload_hash: values[2], publication_id: values[3],
              submitted_at: fromUInt(values[4]), revision: fromUInt(values[5])
            });
            break;
          case 'report_publication_head':
            snapshot.heads.set(values[0], {
              publication_id: values[1], revision: fromUInt(values[2]), submitted_at: fromUInt(values[3])
            });
            break;
          default: throw new Error('Unexpected PostgreSQL table: ' + table);
        }
        return [[]];
      };
      tx.upsert=tx;
      const result = await fn(tx);
      Object.assign(state, snapshot);
      return result;
    }
  };
  return { sql, state, writes };
}

test('Moscow reporting dates use Europe/Moscow rather than hosting timezone', () => {
  assert.equal(moscowDate(Date.parse('2026-11-03T22:45:00Z')), '2026-11-04');
});

test('rejects duplicated recipient, unrecognized report type, or invalid source time', () => {
  assert.throws(() => prepareReportPublication(sample({ kind: 'unknown' })), /Unsupported/);
  assert.throws(() => prepareReportPublication(sample({ submittedAt: now + 900000 })), /time/);
  assert.throws(() => prepareReportPublication(sample({ recipients: [
    recipient('9000000001', 'admission_001', 'a'),
    recipient('9000000001', 'admission_002', 'b')
  ] })), /Ambiguous/);
});

test('atomic publication writes source, two child reports, snapshots, and bland push notifications', async () => {
  const { sql, state, writes } = fakeDb([
    { phone10: '9000000001', admission_id: 'admission_001' },
    { phone10: '9000000002', admission_id: 'admission_002' }
  ]);
  const store = createReportPublicationStore(sql);
  const data = sample();
  const first = await store.publishPrepared(data);
  assert.equal(first.status, 'published');
  assert.equal(first.revision, 1);
  assert.equal(first.notificationsQueued, 2);
  assert.equal(state.raw.size, 1);
  assert.equal(state.current.size, 2);
  assert.equal(state.history.size, 2);
  assert.equal(state.push.size, 2);
  for (const item of state.push.values()) {
    assert.equal(item.data.body.includes('Наблюдение'), false);
    assert.equal(item.data.title, 'Медси Бот');
  }
  const writeCount = writes.length;
  const repeated = await store.publishPrepared(data);
  assert.equal(repeated.status, 'duplicate');
  assert.equal(writes.length, writeCount);
  assert.throws(() => prepareReportPublication(sample({ recipients: [] })), /roster/);
  await assert.rejects(() => store.publishPrepared({ ...data, rawText: 'changed under same id' }), /different report/);
});

test('stale publication does not overwrite newer reports; unchanged child keeps read_version', async () => {
  const { sql, state } = fakeDb([
    { phone10: '9000000001', admission_id: 'admission_001' },
    { phone10: '9000000002', admission_id: 'admission_002' }
  ]);
  const store = createReportPublicationStore(sql);
  const initial = sample();
  await store.publishPrepared(initial);
  const before = state.current.get('9000000001/morning');
  state.current.set('9000000001/morning', { ...before, read_version: before.version });
  const changed = sample({
    submissionId: 'submission_test_002',
    submittedAt: now - 60000,
    recipients: [
      recipient('9000000001', 'admission_001', 'Наблюдение А'),
      recipient('9000000002', 'admission_002', 'Другой отчёт Б')
    ]
  });
  const update = await store.publishPrepared(changed);
  assert.equal(update.status, 'published');
  assert.equal(update.revision, 2);
  assert.equal(update.notificationsQueued, 1);
  assert.equal(state.current.get('9000000001/morning').read_version, before.version);
  assert.equal(state.current.get('9000000002/morning').read_version, '');
  const old = await store.publishPrepared(sample({ submissionId: 'submission_test_003', submittedAt: now - 90000 }));
  assert.equal(old.status, 'superseded');
  assert.equal(state.current.get('9000000002/morning').text, 'Другой отчёт Б');
});

test('roster/admission mismatch fails closed without writing anything', async () => {
  const { sql, state } = fakeDb([
    { phone10: '9000000001', admission_id: 'admission_001' },
    { phone10: '9000000002', admission_id: 'admission_NEW' }
  ]);
  const store = createReportPublicationStore(sql);
  await assert.rejects(() => store.publishPrepared(sample()), /roster changed/);
  assert.equal(state.raw.size, 0);
  assert.equal(state.current.size, 0);
  assert.equal(state.push.size, 0);
});

test('PostgreSQL connection requires isolated opt-in and verified TLS',()=>{
  assert.throws(()=>readPostgresConfig({}),/explicitly enabled/);
  const base={MEDSI_NEXT_PG_ENABLED:'1',MEDSI_NEXT_STAND:'1',
    PGHOST:'db.example.invalid',PGDATABASE:'medsi',PGUSER:'app',PGPASSWORD:'synthetic'};
  assert.throws(()=>readPostgresConfig(base),/trusted TLS CA/);
  assert.throws(()=>readPostgresConfig({...base,PG_SSL_CA_PEM:'not-a-certificate'}),/trusted TLS CA/);
});

test('ownership records are fenced and committed atomically with a publication', async () => {
  const {sql,state}=fakeDb([
    { phone10: '9000000001', admission_id: 'admission_001' },
    { phone10: '9000000002', admission_id: 'admission_002' }
  ]);
  const store=createReportPublicationStore(sql);
  const key='RAW_REPORT_OWNER_morning_'+'a'.repeat(24);
  const ownerReads={[key]:''};
  const ownerWrites={[key]:JSON.stringify({identity:'synthetic',childAdmissionId:'admission_001'})};
  const result=await store.publishPrepared(sample({ownerReads,ownerWrites}));
  assert.equal(result.status,'published');
  assert.equal(state.ownership.get(key),ownerWrites[key]);
  await assert.rejects(() => store.publishPrepared(sample({
    submissionId:'submission_test_other', submittedAt: now - 40000,
    ownerReads:{[key]:''},
    ownerWrites:{[key]:'another-owner'}
  })), /ownership changed/);
  assert.equal(state.ownership.get(key),ownerWrites[key]);
});

test('raw correction redistributes, retains report date and suppresses a recent duplicate push',async()=>{
 const {sql,state}=fakeDb([{phone10:'9000000001',admission_id:'admission_001'},{phone10:'9000000002',admission_id:'admission_002'}]);
 const store=createReportPublicationStore(sql),first=await store.publishPrepared(sample());
 const corrected=await store.publishPrepared(sample({submissionId:'correction_test_001',submittedAt:now-1000,correctionOf:first.publicationId,
 rawText:'Ребёнок А: уточнение',normalizedText:'Ребёнок А: уточнение',recipients:[recipient('9000000001','admission_001','Уточнение А'),recipient('9000000002','admission_002','Уточнение Б')]}));
 assert.equal(corrected.notificationsQueued,0);assert.equal(state.push.size,2);
 assert.equal(state.current.get('9000000001/morning').text,'Уточнение А');
 assert.equal(state.raw.get(corrected.publicationId).report_date,state.raw.get(first.publicationId).report_date);
 await assert.rejects(()=>store.publishPrepared(sample({submissionId:'correction_test_002',submittedAt:now,correctionOf:first.publicationId})),/Report changed/);
});
