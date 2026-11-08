import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

// Bundle the EXACT tested historical parsing/distribution/ownership algorithms locally.
// Fixed own-repository files only; no user-provided code is evaluated.
// This is an isolated adapter, not a Google Apps Script execution dependency.
const SOURCE_FILES = [
  'report-rules.js', 'report-names.js', 'report-parser.js',
  'report-admissions.js', 'report-distribution.js', 'Медси бот.js'
];
const sourceCode = SOURCE_FILES.map(file => readFileSync(
  new URL('../legacy-report-source/' + file, import.meta.url), 'utf8'
));
const PHONE = /^\d{10}$/;
const MISSING = 'Пока ещё нет отчёта 🙏';

function syntheticSheet(name, rows) {
  return {
    getName() { return name; },
    getLastRow() { return rows.length; },
    getDataRange() { return this.getRange(1, 1, rows.length, Math.max(...rows.map(row => row.length), 1)); },
    getRange(startRow, startCol, rowCount = 1, colCount = 1) {
      const getValues = () => Array.from({ length: rowCount }, (_, i) =>
        Array.from({ length: colCount }, (_, j) => rows[startRow + i - 1]?.[startCol + j - 1] ?? ''));
      return {
        getValue() { return getValues()[0][0]; },
        getValues,
        setValue() { throw new Error('Legacy report engine must not write to synthetic Sheets.'); },
        setValues() { throw new Error('Legacy report engine must not write to synthetic Sheets.'); }
      };
    }
  };
}

function validateInput(input) {
  const profiles = Array.isArray(input?.profiles) ? input.profiles : [];
  if (profiles.length === 0 || profiles.length > 200) throw new Error('Invalid active parent roster.');
  const seen = new Set();
  for (const profile of profiles) {
    const phone10 = String(profile.phone10 || '');
    if (!PHONE.test(phone10) || seen.has(phone10)) throw new Error('Invalid or duplicated parent phone.');
    if (!String(profile.childName || '').trim() || !String(profile.admissionId || '').trim()) {
      throw new Error('Child identity or admission is missing.');
    }
    seen.add(phone10);
  }
  const variants = Array.isArray(input.nameVariants) ? input.nameVariants : [];
  if (variants.length > 2000) throw new Error('Too many name variant entries.');
  const ownerRecords = input.ownerRecords || {};
  if (ownerRecords === null || typeof ownerRecords !== 'object' || Array.isArray(ownerRecords)) {
    throw new Error('Invalid report ownership records.');
  }
  return { profiles, variants, ownerRecords };
}

function makeLegacyContext(input) {
  const { profiles, variants, ownerRecords } = validateInput(input);
  const reportRows = [
    ['PHONE', 'PARENT', 'CHILD', 'FAMILY', 'MORNING', 'EVENING', 'RELATIONSHIP', 'ADMISSION_ID', 'PROFILE_GENERATION'],
    ...profiles.map(row => [
      '8' + row.phone10, String(row.parentName || ''), String(row.childName || ''),
      String(row.surname || ''), String(row.morning || ''), String(row.evening || ''),
      String(row.relationship || ''), String(row.admissionId), String(row.profileGeneration || '')
    ])
  ];
  const sheets = new Map([
    ['REPORTS', syntheticSheet('REPORTS', reportRows)],
    ['MORNING', syntheticSheet('MORNING', [['']])],
    ['EVENING', syntheticSheet('EVENING', [['']])],
    ['PSYCHOLOGY', syntheticSheet('PSYCHOLOGY', [['']])],
    ['NAME_VARIANTS', syntheticSheet('NAME_VARIANTS', [
      ['PREFERRED', 'VARIANTS'],
      ...variants.map(v => [String(v.preferredName || ''), String(v.variants || '')])
    ])]
  ]);
  const properties = new Map([
    ['MEDSI_SPREADSHEET_ID', 'synthetic-next'],
    ...Object.entries(ownerRecords).map(([key, value]) => [key, String(value)])
  ]);
  // Existing ownership fallback keys are also preserved for the transition.
  profiles.forEach(row => properties.set('REPORT_ADMISSION_' + row.phone10, String(row.admissionId)));
  const scriptProperties = {
    getProperty(key) { return properties.get(key) || ''; },
    getProperties() { return Object.fromEntries(properties); },
    setProperty(key, value) { properties.set(key, String(value)); }
  };
  const api = {
    Logger: { log() {} },
    SpreadsheetApp: {
      openById() { return { getSheetByName: name => sheets.get(name) || null }; }
    },
    PropertiesService: { getScriptProperties() { return scriptProperties; } },
    Utilities: {
      getUuid: randomUUID,
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest(_, text) { return Array.from(createHash('sha256').update(String(text), 'utf8').digest()); },
      base64EncodeWebSafe(bytes) { return Buffer.from(bytes).toString('base64url'); },
      formatDate(date, _zone, _format) { return new Date(date).toISOString().slice(0, 10); }
    }
  };
  vm.createContext(api);
  for (const code of sourceCode) vm.runInContext(code, api, { timeout: 5000 });
  return { api, properties };
}

export function planLegacyReport(input) {
  const kind = String(input?.kind || '');
  if (!['morning', 'evening', 'psychology'].includes(kind)) throw new Error('Unsupported report type.');
  const rawText = String(input?.rawText || '');
  if (!rawText.trim() || rawText.length > 240000) throw new Error('Missing or oversized raw report.');
  const { profiles, ownerRecords } = validateInput(input);
  const { api, properties } = makeLegacyContext(input);

  if (kind === 'psychology') {
    // The shared legacy punctuation normalizer collapses blank lines because
    // morning/evening reports use line-oriented child headers. Therapy notes
    // are prose: normalize each paragraph separately to keep their boundaries
    // in the parent-facing PostgreSQL text (without changing other report kinds).
    const normalizedText = rawText.replace(/\r\n?/g, '\n')
      .split(/\n[ \t]*\n+/)
      .map(paragraph => api.normalizeReportSourcePunctuation_(paragraph))
      .filter(Boolean).join('\n\n');
    if (!normalizedText.trim()) throw new Error('Psychology report is empty.');
    return {
      kind, rawText, normalizedText,
      recipients: profiles.map(profile => ({
        phone10: profile.phone10, admissionId: profile.admissionId, text: normalizedText
      })),
      ownerReads: {}, ownerWrites: {},
      validation: { ok: true }
    };
  }

  const prepared = api.prepareRawReportSourceText_(kind, rawText);
  if (!prepared || !prepared.ok) {
    const error = new Error(String(prepared?.message || 'Отчёт содержит ошибку.').slice(0, 500));
    error.code = 'REPORT_FORMAT_ERROR';
    error.validation = prepared?.validation || null;
    throw error;
  }
  const children = api.buildReportValidationChildren_();
  if (children.length !== profiles.length) throw new Error('Report roster changed.');
  const context = api.buildDistributionContext_(children, []);
  const parsed = api.computeReportKindPlan_(kind, prepared.text, children, context);
  if (!parsed?.ok) throw new Error('Legacy distribution failed.');

  // Identical logic to Apps Script appendReport()/distributeChildReports():
  // establish original-block ownership first, then read guarded assignments.
  api.rememberRawReportPublicationOwnership_(kind, prepared.text, rawText);
  const guarded = api.planRawReportOwnershipGuard_(
    kind, parsed.parsed, context, parsed.distribution,
    profiles.map(profile => kind === 'morning' ? String(profile.morning || '') : String(profile.evening || '')),
    false, api.loadRawReportOwnershipRecords_(kind, parsed.parsed), Date.now()
  );
  if (guarded.distribution.ownershipBlockedRows) {
    const error = new Error('Report blocked by previous admission or conflicting child identity.');
    error.code = 'REPORT_OWNERSHIP_ERROR';
    throw error;
  }
  const storedNames = profiles.map(p => String(p.childName || ''));
  const values = api.buildReportRowValues_(storedNames, guarded.distribution.byRow, MISSING);
  const ownerWrites = {};
  for (const [key, value] of properties.entries()) {
    if (key.startsWith('RAW_REPORT_OWNER_') && String(ownerRecords[key] || '') !== value) {
      ownerWrites[key] = value;
    }
  }
  Object.assign(ownerWrites, guarded.proposedOwnershipWrites);
  return {
    kind, rawText, normalizedText: prepared.text,
    recipients: profiles.map((profile, index) => ({
      phone10: profile.phone10, admissionId: profile.admissionId,
      text: values[index] && values[index][0] || MISSING
    })),
    ownerReads: Object.fromEntries(
      Object.keys(ownerWrites).map(key => [key, String(ownerRecords[key] || '')])
    ),
    ownerWrites,
    validation: { ok: true, checkedBlocks: prepared.validation.checkedBlocks || 0,
      skippedBlocks: prepared.validation.skippedBlocks || 0,
      ambiguousNames: prepared.validation.ambiguousNames || [] }
  };
}
