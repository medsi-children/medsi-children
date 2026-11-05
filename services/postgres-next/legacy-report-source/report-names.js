/* Shared Apps Script global module. Function bodies retained verbatim;
 * no module wrapper so Apps Script and the test VM share the same globals. */

function loadNameEquivalents_() {
  const dict = {};
  const canon = {};
  const preferred = {};
  const sheet = getSheet_('NAME_VARIANTS');
  if (!sheet) {
    Logger.log('⚠️ Лист NAME_VARIANTS не найден');
    return { dict, canon, preferred };
  }

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const canonRaw = String(data[i][0] || '');
    const variantsRaw = String(data[i][1] || '');
    addNameVariantRow_(dict, canon, canonRaw, variantsRaw);
    const canonKey = normalizeName_(canonRaw);
    if (canonKey && !preferred[canonKey]) preferred[canonKey] = canonRaw.trim();
  }

  Logger.log(`📖 Загружено ${Object.keys(dict).length} групп вариантов имён`);
  return { dict, canon, preferred };
}

function ensureNameEquivalentsLoaded_() {
  if (NAME_DATA) return;
  NAME_DATA = loadNameEquivalents_();
  NAME_EQUIVALENTS = NAME_DATA.dict;
  CANON_NAME_MAP = NAME_DATA.canon;
  PREFERRED_NAME_MAP = NAME_DATA.preferred || {};
}

// Historical helper kept for compatibility. NAME_VARIANTS is now matching-only:
// It must never rename the child's stored/display first name.
function canonizeChildName_(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw) return raw;

  const base = stripInitialFromName_(raw) || raw;
  const suf  = getSuffixToken_(raw);

  return suf ? `${base} ${suf}` : base;
}

// First column of NAME_VARIANTS is the preferred spelling for raw report
// headings. It is a display choice only; every listed form remains equivalent
// for matching, and the registered name stays in REPORTS/parent views.
function getPreferredNameVariant_(nameRaw) {
  ensureNameEquivalentsLoaded_();
  const key = normalizeName_(stripInitialFromName_(nameRaw));
  const groupKey = CANON_NAME_MAP && CANON_NAME_MAP[key] || key;
  return PREFERRED_NAME_MAP && PREFERRED_NAME_MAP[groupKey]
    ? String(PREFERRED_NAME_MAP[groupKey]).trim()
    : '';
}

function normRu(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function capWord(w) {
  const s = String(w || '');
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function normalizeFamilyName_(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z]/g, '')
    .trim();
}

function compareFamiliesSmart_(fam1, fam2) {
  const n1 = normalizeFamilyName_(fam1);
  const n2 = normalizeFamilyName_(fam2);
  if (!n1 || !n2) return false;

  const minLen = Math.min(5, n1.length, n2.length);
  return n1.slice(0, minLen) === n2.slice(0, minLen);
}

function normalizeName_(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function baseNameTrimInitial_(s) {
  return String(s || '').trim().replace(/\s+[А-ЯЁ]\.?$/, '').trim();
}

function getAllNameVariantsForBase_(baseRaw) {
  ensureNameEquivalentsLoaded_();
  const cleaned = String(baseRaw || '')
    .replace(/❗️|❗|‼️|‼|!+/g, '')
    .trim();

  const base = cleaned;
  const baseNoInit = baseNameTrimInitial_(base);

  const key0 = normalizeName_(baseNoInit);
  const key  = (CANON_NAME_MAP && CANON_NAME_MAP[key0]) ? CANON_NAME_MAP[key0] : key0;

  const eqs = NAME_EQUIVALENTS[key] || [];

  const eqPretty = eqs.map(v => {
    const s = String(v || '').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  });

  let suffix = '';
  if (baseNoInit && base.startsWith(baseNoInit)) {
    suffix = base.slice(baseNoInit.length);
  } else {
    const m = base.match(/(\s+[А-ЯЁ][а-яё]{0,9})\s*$/);
    suffix = m ? m[1] : '';
  }

  suffix = String(suffix || '').replace(/\s+/g, ' ');
  if (suffix && !suffix.startsWith(' ')) suffix = ' ' + suffix.trim();
  if (suffix === ' ') suffix = '';

  const out = [];

  function add(v) {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }

  add(base);
  if (baseNoInit && baseNoInit !== base) add(baseNoInit);
  eqPretty.forEach(v => add(v));

  if (suffix) {
    eqPretty.forEach(v => add(v + suffix));
  }

  return out;
}
