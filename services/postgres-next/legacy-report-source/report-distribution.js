// Pure report-row formatting shared by publication and directory maintenance.
// The callers retain ownership of writes, notifications and publication state.
function buildReportRowValues_(storedNamesRaw, assignedRowsRaw, missingTextRaw) {
  const storedNames = Array.isArray(storedNamesRaw) ? storedNamesRaw : [];
  const assignedRows = assignedRowsRaw && typeof assignedRowsRaw === 'object' ? assignedRowsRaw : [];
  const missingText = String(missingTextRaw || 'Пока ещё нет отчёта 🙏');
  return storedNames.map(function(storedNameRaw, index) {
    const storedName = String(storedNameRaw || '').trim();
    const cleanName = stripInitialFromName_(storedName) || storedName;
    const assigned = assignedRows[index] || missingText;
    return [prepareReportForParent_(assigned, storedName, cleanName)];
  });
}

// Pure calculation shared by publication and directory maintenance. Callers
// still apply the persisted ownership guard and own all Sheets/Worker effects.
function computeReportKindPlan_(kindRaw, rawText, childrenRaw, contextByBase) {
  const kind = String(kindRaw || '').toLowerCase();
  if (kind !== 'morning' && kind !== 'evening') return { ok:false, message:'Неизвестный вид отчёта.' };
  const children = Array.isArray(childrenRaw) ? childrenRaw : [];
  const knownBaseKeys = buildKnownBaseKeys_(children);
  const parsed = parseReportBlocks_(String(rawText || ''), knownBaseKeys, contextByBase || {});
  const distribution = buildSafeDistribution_(kind, parsed, contextByBase || {});
  return { ok:true, kind:kind, parsed:parsed, distribution:distribution };
}

// Avoid rewriting an entire report column when its displayed values are identical.
function reportColumnValuesChanged_(previousRaw, nextRaw) {
  const previous = Array.isArray(previousRaw) ? previousRaw : [];
  const next = Array.isArray(nextRaw) ? nextRaw : [];
  return previous.length !== next.length || next.some(function(row, index) {
    return String(row && row[0] || '') !== String(previous[index] && previous[index][0] || '');
  });
}
