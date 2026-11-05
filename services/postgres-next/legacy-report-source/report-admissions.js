// Stable identity for one active child's admission, shared by matching parent
// rows. Stored in hidden REPORTS!H (currently the first unused column) so
// report distribution can use it locally.
const REPORT_CHILD_ADMISSION_COLUMN_ = 8;
const REPORT_CHILD_ADMISSION_HEADER_ = 'ID поступления (служебный)';

function ensureReportAdmissionColumn_(sheet) {
  if (!sheet) throw new Error('Лист REPORTS не найден.');
  if (sheet.getMaxColumns() < REPORT_CHILD_ADMISSION_COLUMN_) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), REPORT_CHILD_ADMISSION_COLUMN_ - sheet.getMaxColumns());
  }
  const header = String(sheet.getRange(1, REPORT_CHILD_ADMISSION_COLUMN_).getValue() || '').trim();
  if (header && header !== REPORT_CHILD_ADMISSION_HEADER_) {
    throw new Error('REPORTS!H уже занята другим полем; ID поступления не записан.');
  }
  if (!header) {
    const count = Math.max(0, sheet.getLastRow() - 1);
    const existing = count ? sheet.getRange(2, REPORT_CHILD_ADMISSION_COLUMN_, count, 1).getValues() : [];
    if (existing.some(function(row) { return String(row[0] || '').trim(); })) {
      throw new Error('REPORTS!H содержит данные без заголовка; ID поступления не записан.');
    }
    sheet.getRange(1, REPORT_CHILD_ADMISSION_COLUMN_).setValue(REPORT_CHILD_ADMISSION_HEADER_);
  }
  try {
    if (!sheet.isColumnHiddenByUser(REPORT_CHILD_ADMISSION_COLUMN_)) sheet.hideColumns(REPORT_CHILD_ADMISSION_COLUMN_);
  } catch (_) {}
}

function isReportAdmissionId_(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function reportAdmissionChildKey_(nameRaw, familyRaw) {
  const fullName = normalizeReportChildName_(nameRaw, familyRaw);
  const child = buildReportChildren_([fullName], [familyRaw])[0];
  return reportChildIdentityKey_(child);
}

// One-time/periodic backfill and registration helper. Existing rows with the
// same current report identity share one ID; a new admission after all old rows
// have been removed receives a new UUID. Conflicting manually assigned IDs are
// preserved and left ambiguous rather than silently merged.
function ensureReportAdmissionIds_(sheetRaw) {
  const sheet = sheetRaw || getDataSheet_();
  if (!sheet) throw new Error('Лист REPORTS не найден.');
  ensureReportAdmissionColumn_(sheet);
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (!count) return { ok:true, assigned:0 };
  const rows = sheet.getRange(2, 1, count, REPORT_CHILD_ADMISSION_COLUMN_).getValues();
  rows.forEach(function(row) {
    const id = String(row[REPORT_CHILD_ADMISSION_COLUMN_ - 1] || '').trim();
    if (id && !isReportAdmissionId_(id)) throw new Error('В REPORTS!H найдено неизвестное значение; ID поступления не изменены.');
  });
  const groups = {};
  rows.forEach(function(row, index) {
    if (!last10_(row[0]) || !String(row[2] || '').trim()) return;
    const key = reportAdmissionChildKey_(row[2], row[3]);
    if (!key) return;
    (groups[key] || (groups[key] = [])).push(index);
  });
  const ids = rows.map(function(row) { return [String(row[7] || '').trim()]; });
  let assigned = 0;
  Object.keys(groups).forEach(function(key) {
    const indexes = groups[key];
    const existing = uniqueStrings_(indexes.map(function(index) { return ids[index][0]; }).filter(Boolean));
    const id = existing.length === 1 ? existing[0] : (existing.length ? '' : Utilities.getUuid());
    if (!id) return;
    indexes.forEach(function(index) {
      if (ids[index][0]) return;
      ids[index][0] = id;
      assigned += 1;
    });
  });
  if (assigned) sheet.getRange(2, REPORT_CHILD_ADMISSION_COLUMN_, count, 1).setValues(ids);
  return { ok:true, assigned:assigned };
}

function reportAdmissionIdForNewChild_(sheet, childName, familyName) {
  ensureReportAdmissionIds_(sheet);
  const key = reportAdmissionChildKey_(childName, familyName);
  const count = Math.max(0, sheet.getLastRow() - 1);
  if (count) {
    const rows = sheet.getRange(2, 1, count, REPORT_CHILD_ADMISSION_COLUMN_).getValues();
    const matches = rows.filter(function(row) {
      return last10_(row[0]) && reportAdmissionChildKey_(row[2], row[3]) === key;
    });
    const ids = uniqueStrings_(matches.map(function(row) { return String(row[7] || '').trim(); }).filter(Boolean));
    if (ids.length > 1) throw new Error('Для этого имени в REPORTS несколько ID поступления; регистрация остановлена для ручной проверки.');
    if (ids.length === 1) return ids[0];
  }
  return Utilities.getUuid();
}
