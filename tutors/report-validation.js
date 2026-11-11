// Shared report rules. Apps Script publishes an identical generated copy.
var MedsiReportValidation = (function() {
  'use strict';

  // These groups only detect names that need initials. They never rename
  // children or replace the authoritative Apps Script NAME_VARIANTS sheet.
  const nameGroups = [
    ['александр', 'александра', 'саша'],
    ['евгений', 'евгения', 'женя'],
    ['валентин', 'валентина', 'валя'],
    ['елизавета', 'лиза'], ['екатерина', 'катя'], ['мария', 'маша'],
    ['дарья', 'даша'], ['анастасия', 'настя'], ['анна', 'аня'],
    ['татьяна', 'таня'], ['софья', 'софия', 'соня'], ['варвара', 'варя'],
    ['владимир', 'вова', 'володя'], ['иван', 'ваня'], ['дмитрий', 'дима'],
    ['михаил', 'миша'], ['николай', 'коля'], ['алексей', 'леша', 'алеша'],
    ['артем', 'тема'], ['андрей', 'андрюша'], ['роман', 'рома'],
    ['максим', 'макс'], ['сергей', 'сережа'], ['петр', 'петя'],
    ['елена', 'лена'], ['ольга', 'оля'], ['юлия', 'юля'], ['ксения', 'ксюша']
  ];
  const groupByName = new Map();
  nameGroups.forEach(group => group.forEach(name => groupByName.set(name, group[0])));
  const serviceNames = new Set([
    'поступление', 'поступления', 'выписка', 'выписки', 'отчет', 'утро',
    'день', 'вечер', 'игры', 'общение', 'прогулка', 'прогулки', 'кинофильм',
    'занятия', 'активности', 'автор', 'авторы', 'составили', 'составил', 'составила',
    'воспитатель', 'воспитатели', 'палата'
  ]);

  function key(value) {
    return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\./g, '').trim();
  }

  function sourceLines(text) {
    return String(text || '').normalize('NFC')
      .replace(/\r\n?|[\u2028\u2029]/g, '\n')
      .replace(/[\u200B-\u200F\uFEFF]/g, '')
      .replace(/[\u00A0\u202F\u2000-\u200A]/g, ' ')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .split('\n');
  }

  function forbiddenHeading(line) {
    // Ignore decorative symbols only before the heading, not words in a body.
    const heading = line.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
    if (/^(?:для[ \t]+врач(?:ей|а)|врачам)(?=[^\p{L}]|$)/u.test(heading)) return 'Для врачей';
    if (/^общ(?:ий|ие)[ \t]+комментар(?:ий|ии)(?=[^\p{L}]|$)/u.test(heading)) return 'Общий комментарий';
    return '';
  }

  function removeRoomPrefix(line) {
    return line.trim().replace(
      /^(?:палата[^\S\r\n]+)?(?:№[^\S\r\n]*)?(?:50[1-9]|51[0-2])[^\S\r\n]*(?:[:.,;\/\-–—][^\S\r\n]*)?(?=[А-ЯЁ])/i, ''
    );
  }

  function childHeader(line, lineNumber) {
    // WhatsApp and notes often prefix a header with an emoji (e.g. "📌Имя:").
    // Ignore only leading decorations for validation; never change report body.
    // Check both sides of a possible room number ("📌 501: 📌Имя:").
    const withoutDecorations = String(line || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').trimStart();
    const withoutRoom = removeRoomPrefix(withoutDecorations)
      .replace(/^[^\p{L}\p{N}]+/u, '').trimStart();
    // Only an explicit colon or dash starts a block. Bare name mentions are prose.
    const match = /^([А-ЯЁ][а-яё]+)(?:[ \t]+([А-ЯЁ](?:[а-яё]+)?\.?))?[ \t]*[:\-–—]/iu.exec(withoutRoom);
    if (!match || serviceNames.has(key(match[1]))) return null;
    const base = key(match[1]);
    return {
      name:match[1], base, group:groupByName.get(base) || base,
      suffix:key(match[2]), label:match[1] + (match[2] ? ' ' + match[2] : ''),
      line:lineNumber
    };
  }

  function stripRoomNumbers(text) {
    const lines = String(text || '').replace(/\r\n?|[\u2028\u2029]/g, '\n').split('\n');
    const parsed = sourceLines(lines.join('\n'));
    const headers = parsed.map((line, index) => childHeader(line, index + 1));
    const roomOnly = line => /^(?:палата[ \t]+)?(?:№[ \t]*)?(?:50[1-9]|51[0-2])[ \t]*[:.,;\/\-–—]?[ \t]*$/i.test(line.trim());
    let insideChild = false;
    const result = [];
    lines.forEach((line, index) => {
      if (headers[index]) {
        insideChild = true;
        // Remove a label before the name, never a number after its separator.
        result.push(removeRoomPrefix(line));
        return;
      }
      if (roomOnly(parsed[index])) {
        let next = index + 1;
        while (next < parsed.length && !parsed[next].trim()) next++;
        if (!insideChild || headers[next]) return;
      }
      if (!insideChild) {
        // Only report preamble is eligible for general room-label removal.
        result.push(line.replace(/(^|[^0-9A-Za-zА-ЯЁа-яё.])[ \t]*(?:№[ \t]*)?(?:50[1-9]|51[0-2])(?![0-9A-Za-zА-ЯЁа-яё])[ \t]*:?[ \t]*/g, '$1'));
      } else {
        result.push(line);
      }
    });
    return result.join('\n');
  }

  function failure(issues) {
    return {ok:false, code:'REPORT_FORMAT_ERROR', issues, message:[...new Set(issues.map(issue => issue.message))].join('\n')};
  }

  function validate(kind, text) {
    if (!String(text || '').trim()) return failure([{reason:'empty', message:'Добавьте текст отчёта.'}]);
    if (kind === 'psychology') return {ok:true};
    const lines = sourceLines(text);
    const forbidden = [];
    const headers = [];
    lines.forEach((line, index) => {
      const heading = forbiddenHeading(line);
      if (heading) forbidden.push({reason:'service_section', line:index + 1,
        message:heading === 'Для врачей'
          ?'Найден блок для врачей, пожалуйста, удалите его.'
          :'Найден общий комментарий, пожалуйста, удалите его.'});
      const header = childHeader(line, index + 1);
      if (header) headers.push(header);
    });
    if (forbidden.length) return failure(forbidden);
    if (!headers.length) return failure([{reason:'no_child_headers',
      message:'Не найдены блоки детей. Проверьте заголовки с именами.'}]);

    const groups = new Map();
    headers.forEach(header => {
      if (!groups.has(header.group)) groups.set(header.group, []);
      groups.get(header.group).push(header);
    });
    const issues = [];
    groups.forEach(items => {
      if (items.length < 2) return;
      const bare = items.filter(item => !item.suffix);
      const differentForms = new Set(items.map(item => item.base)).size > 1;
      const labels = Array.from(new Set(items.map(item => item.label))).map(label => `«${label}»`).join(', ');
      if (bare.length) {
        const reason = bare.length === items.length && !differentForms ? 'duplicate_name' : 'missing_initial';
        let message;
        if (differentForms) {
          message = `Встречаются похожие имена: ${labels}. Уточните инициалы или фамилии.`;
        } else if (reason === 'duplicate_name') {
          message = `Имя «${items[0].name}» повторяется. Удалите лишний блок или добавьте инициалы.`;
        } else {
          message = `Имя «${bare[0].name}» указано без инициала. Добавьте инициал или фамилию.`;
        }
        issues.push({reason, lines:items.map(item => item.line), message});
        return;
      }
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          if (!items[i].suffix.startsWith(items[j].suffix) && !items[j].suffix.startsWith(items[i].suffix)) continue;
          issues.push({reason:'duplicate_header', lines:[items[i].line, items[j].line],
            message:`Найдены похожие блоки: «${items[i].label}» и «${items[j].label}». Уберите повтор или уточните фамилии.`});
          return;
        }
      }
    });
    return issues.length ? failure(issues) : {ok:true, checkedBlocks:headers.length};
  }

  return Object.freeze({validate, stripRoomNumbers});
})();
if (typeof module === 'object' && module.exports) module.exports = MedsiReportValidation;
if (typeof window === 'object') window.MedsiReportValidation = MedsiReportValidation;
