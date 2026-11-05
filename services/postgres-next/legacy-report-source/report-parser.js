/* Shared Apps Script global module. Functions and constants are unchanged;
 * no module wrapper so Apps Script and the test VM share the same globals. */

const REPORT_NON_NAME_HEADER_WORDS_ = {
  аппетит: true,
  активность: true,
  активности: true,
  анализы: true,
  арт: true,
  беседа: true,
  вечер: true,
  врач: true,
  врача: true,
  врачам: true,
  врачи: true,
  врачей: true,
  завтрак: true,
  занятие: true,
  занятия: true,
  игры: true,
  итог: true,
  итоги: true,
  кино: true,
  киносеанс: true,
  комментарий: true,
  обед: true,
  обход: true,
  общение: true,
  отчет: true,
  отчёт: true,
  полдник: true,
  прогулка: true,
  прогулки: true,
  самочувствие: true,
  сон: true,
  танцы: true,
  терапия: true,
  творчество: true,
  ужин: true,
  утро: true,
  йога: true
};

const REPORT_SERVICE_HEADER_PHRASES_ = {
  'для врачей': true,
  врачам: true,
  поступление: true,
  'общий комментарий': true,
  'сегодня у ребят были': true
};

function cleanReportTextForParsing_(text) {
  const EXCL = /[!！‼️❗️❗❕❕]+/g;

  let clean = String(text || '')
    .replace(EXCL, '')
    .replace(/\r/g, '\n')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return stripRoomNumbers_(clean)
    .replace(/(\b\d{1,2})\s*:\s*(\d{2})(\b)/g, '$1:$2$3')
    .replace(/(\b\d{1,2})\s*:\s*(\d{2})\s*:\s*(\d{2})(\b)/g, '$1:$2:$3$4')
    .trim();
}

function stripRoomNumbers_(text) {
  return MedsiReportValidation.stripRoomNumbers(text);
}

function normalizeSuffixKey_(suffixRaw) {
  return String(suffixRaw || '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Russian reports are sometimes typed with a Latin keyboard. Normalize
    // visually identical Latin letters in initials/prefixes so "Саша K"
    // can match a Russian surname beginning with "К".
    .replace(/[abcehkmoptxy]/g, function(letter) {
      return ({a:'а',b:'в',c:'с',e:'е',h:'н',k:'к',m:'м',o:'о',p:'р',t:'т',x:'х',y:'у'})[letter] || letter;
    })
    .replace(/[^а-яa-z]/g, '');
}

function isInitialSuffixKey_(suffixKey) {
  return String(suffixKey || '').length === 1;
}

function getNameBaseKey_(nameRaw) {
  ensureNameEquivalentsLoaded_();
  const base = stripInitialFromName_(nameRaw);
  const key0 = normalizeName_(base);
  return (CANON_NAME_MAP && CANON_NAME_MAP[key0]) ? CANON_NAME_MAP[key0] : key0;
}

function getReportHeaderParts_(nameRaw) {
  const name = String(nameRaw || '')
    .replace(/❗️|❗|‼️|‼|!+/g, '')
    .replace(/\.\s*$/g, '')
    .trim();

  const suffix = getSuffixToken_(name);

  return {
    raw: name,
    baseRaw: stripInitialFromName_(name),
    baseKey: getNameBaseKey_(name),
    suffix,
    suffixKey: normalizeSuffixKey_(suffix),
    hasSuffix: !!suffix
  };
}

function normalizeReportHeaderPhrase_(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isServiceReportHeader_(raw) {
  const phrase = normalizeReportHeaderPhrase_(raw);
  return !!(phrase && REPORT_SERVICE_HEADER_PHRASES_[phrase]);
}

function isNonNameReportHeader_(raw) {
  const phrase = normalizeReportHeaderPhrase_(raw);
  if (!phrase) return true;
  if (isServiceReportHeader_(raw)) return true;
  if (/\d/.test(String(raw || ''))) return true;

  const compact = phrase.replace(/\s+/g, '');
  if (REPORT_NON_NAME_HEADER_WORDS_[compact]) return true;

  return false;
}

function getReportAliasCandidateKey_(header) {
  const key = normalizeName_(header && header.baseRaw);
  if (!key) return '';
  if (key.indexOf(' ') !== -1) return '';
  if (key.length < 4 || key.length > 12) return '';
  if (isNonNameReportHeader_(key)) return '';

  return key;
}

function commonPrefixLength_(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const limit = Math.min(left.length, right.length);
  let i = 0;
  while (i < limit && left.charAt(i) === right.charAt(i)) i += 1;
  return i;
}

function levenshteinDistance_(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const prev = [];
  const curr = [];

  for (let j = 0; j <= right.length; j += 1) prev[j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left.charAt(i - 1) === right.charAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
  }

  return prev[right.length] || 0;
}

function isProbableReportNameAlias_(aliasKey, childBaseKey) {
  const alias = String(aliasKey || '');
  const base = String(childBaseKey || '');
  if (!alias || !base || alias === base) return false;
  if (alias.length < 4 || base.length < 4) return false;

  const prefix = commonPrefixLength_(alias, base);
  if (prefix < 3) return false;

  const distance = levenshteinDistance_(alias, base);
  if (distance <= 2) return true;

  return prefix >= 4 && distance <= 3 && Math.max(alias.length, base.length) <= 8;
}

function findProbableReportAliasChildren_(header, contextByBase) {
  const aliasKey = getReportAliasCandidateKey_(header);
  if (!aliasKey || !contextByBase) return [];

  const found = [];
  const seen = {};

  Object.keys(contextByBase).forEach(baseKey => {
    if (!isProbableReportNameAlias_(aliasKey, baseKey)) return;

    const ctx = contextByBase[baseKey] || {};
    const active = (ctx.registered || []).filter(Boolean);
    active.forEach(child => {
      const key = reportChildIdentityKey_(child) || ('row:' + child.index);
      if (seen[key]) return;
      seen[key] = true;
      found.push(child);
    });
  });

  return found;
}

function makeUnknownReportAliasResolution_(children) {
  const list = (children || []).filter(Boolean);
  return {
    status: 'unknown_alias',
    child: null,
    children: list,
    reason: 'Заголовок похож на вариант имени активного ребёнка, но не найден в NAME_VARIANTS.'
  };
}

function makeUnassignedReportHeaderResolution_() {
  return {
    status: 'unassigned_header',
    child: null,
    children: [],
    reason: 'Заголовок похож на имя, но не привязан к активной строке REPORTS/NAME_VARIANTS.'
  };
}

function isPotentialUnassignedReportHeader_(header) {
  const raw = String(header && header.raw || '').trim();
  if (!raw || isNonNameReportHeader_(raw)) return false;

  const phrase = normalizeReportHeaderPhrase_(raw);
  if (!phrase) return false;

  const parts = phrase
    .split(/[\s-]+/)
    .map(part => part.trim())
    .filter(Boolean);

  if (parts.length < 1 || parts.length > 3) return false;
  if (parts.some(part => REPORT_NON_NAME_HEADER_WORDS_[part])) return false;
  if (parts.every(part => part.length <= 1)) return false;
  if (parts.some(part => part.length > 20)) return false;

  // Здесь не проверяем имя по NAME_VARIANTS намеренно: незнакомые,
  // иностранные или ещё не зарегистрированные имена тоже должны быть
  // границей блока, чтобы не прилипать к предыдущему ребёнку.
  return true;
}

function normalizeReportBlockBody_(bodyRaw) {
  // Стабильная форма для сравнений и ключей защиты. Не менять способ
  // склейки переносов: от него зависят уже сохранённые записи владельцев.
  const flattened = String(bodyRaw || '')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return normalizeReportBlockPunctuation_(flattened);
}

function formatReportBlockBody_(bodyRaw) {
  // Parents receive one continuous paragraph per child, even when an older
  // raw report still contains internal line breaks before canonicalization.
  // Reuse the ownership normalizer so the child's content remains unchanged.
  return normalizeReportBlockBody_(bodyRaw);
}

function normalizeReportBlockPunctuation_(text) {
  // Только безопасная механическая правка: «слово ,следующее» →
  // «слово, следующее» и «слово .» → «слово.». Не исправляем слова,
  // регистр, тире и не трогаем десятичные числа вроде «1,5».
  return String(text || '')
    .replace(/[ \t]+([,.])/g, '$1')
    .replace(/\([ \t]+/g, '(')
    .replace(/[ \t]+\)/g, ')')
    .replace(/,(?=[А-Яа-яЁёA-Za-z])/g, ', ')
    .replace(/([а-яёa-z])\.([А-ЯЁA-Z])/gu, '$1. $2')
    .trim();
}

function normalizeReportSourcePunctuation_(text) {
  // Убираем пустые строки подряд, но оставляем один перенос между строками:
  // заголовки детей остаются явными границами блоков.
  return String(text || '')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(normalizeReportBlockPunctuation_)
    .join('\n');
}

function parseReportBlocks_(text, knownBaseKeys, contextByBase) {
  const clean = cleanReportTextForParsing_(text);
  const blocks = [];
  if (!clean) return { clean, blocks };

  const headerRe = /(^|\n)\s*([^:\-–—\n]+?)\s*(?:\.?\s*[:\-–—])\s*/g;
  const parts = [];
  let m;

  while ((m = headerRe.exec(clean)) !== null) {
    const header = getReportHeaderParts_(m[2].trim());
    const isKnownRegistered = !!(knownBaseKeys && knownBaseKeys[header.baseKey]);
    const isKnownName = isInNameBase(normalizeName_(header.baseRaw));
    const probableAliasChildren = (!isKnownRegistered && !isKnownName)
      ? findProbableReportAliasChildren_(header, contextByBase)
      : [];
    const isProbableAlias = probableAliasChildren.length > 0;
    const isUnassignedHeader = (!isKnownRegistered && !isKnownName && !isProbableAlias)
      ? isPotentialUnassignedReportHeader_(header)
      : false;

    if (!header.baseKey || (!isKnownRegistered && !isKnownName && !isProbableAlias && !isUnassignedHeader)) continue;

    parts.push({
      nameRaw: m[2].trim(),
      header,
      start: m.index,
      headerEnd: headerRe.lastIndex,
      prefix: m[1] || '',
      bodyStart: headerRe.lastIndex,
      forcedResolution: isProbableAlias
        ? makeUnknownReportAliasResolution_(probableAliasChildren)
        : (isUnassignedHeader ? makeUnassignedReportHeaderResolution_() : null)
    });
  }

  parts.sort((a, b) => (a.start - b.start) || (a.headerEnd - b.headerEnd));

  const uniqueParts = [];
  const seenStarts = {};
  parts.forEach(part => {
    const key = String(part.start);
    if (seenStarts[key]) return;
    seenStarts[key] = true;
    uniqueParts.push(part);
  });

  for (let i = 0; i < uniqueParts.length; i++) {
    const bodyEnd = (i + 1 < uniqueParts.length) ? uniqueParts[i + 1].start : clean.length;
    const body = formatReportBlockBody_(clean.slice(uniqueParts[i].bodyStart, bodyEnd));
    const header = uniqueParts[i].header;

    blocks.push({
      rawName: header.raw,
      baseRaw: header.baseRaw,
      baseKey: header.baseKey,
      suffix: header.suffix,
      suffixKey: header.suffixKey,
      hasSuffix: header.hasSuffix,
      body,
      start: uniqueParts[i].start,
      headerEnd: uniqueParts[i].headerEnd,
      prefix: uniqueParts[i].prefix,
      forcedResolution: uniqueParts[i].forcedResolution
    });
  }

  return { clean, blocks };
}
