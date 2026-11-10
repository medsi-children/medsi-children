// The same conservative punctuation rules as Apps Script's
// normalizeReportBlockPunctuation_ (report-parser.js).
// Only mechanical spacing changes: never rewrite words, add punctuation,
// change capitalization, touch decimal commas, or merge authored paragraphs.
export function normalizeCurrentReportPunctuation(text){
  return String(text??'').replace(/\r\n?/g,'\n')
    .split('\n').map(line=>line
      .replace(/[ \t]+([,.])/g,'$1')
      .replace(/\([ \t]+/g,'(')
      .replace(/[ \t]+\)/g,')')
      .replace(/,(?=[А-Яа-яЁёA-Za-z])/g,', ')
      .replace(/([а-яёa-z])\.([А-ЯЁA-Z])/gu,'$1. $2')
    ).join('\n');
}
