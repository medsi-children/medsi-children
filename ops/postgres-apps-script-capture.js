// Migration sidecar. NOT part of apps-script/medsi-bot or its automatic release.
// Run only through an owner-authorized Apps Script execution, never a public
// webapp handler. Return the result directly to the protected migration client;
// never Logger.log it or write it into Sheets/Drive.
function medsiCaptureFrozenMigration(request) {
  if (!request || (request.freezeConfirmed !== true && request.preliminary !== true) ||
      !/^[-A-Za-z0-9_]{12,120}$/.test(String(request.captureId || ''))) {
    throw new Error('Explicit frozen Apps Script capture required.');
  }
  var stage = 'lock';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(request.preliminary === true ? 30000 : 1000)) throw new Error('Apps Script writer is still active.');
  try {
    stage = 'properties';
    var props = PropertiesService.getScriptProperties();
    var initialProperties = props.getProperties();
    var spreadsheetId = initialProperties.MEDSI_SPREADSHEET_ID;
    if (!spreadsheetId) throw new Error('Migration spreadsheet is not configured.');
    stage = 'spreadsheet';
    var ss = SpreadsheetApp.openById(spreadsheetId);
    var required = ['REPORTS','MORNING','EVENING','PSYCHOLOGY','NAME_VARIANTS'];
    var optional = ['DATABASE','DISTRIBUTION_LOG'];
    function normalize(value) {
      if (value instanceof Date) return {dateMilliseconds:String(value.getTime())};
      if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
          (typeof value === 'number' && isFinite(value))) return value;
      throw new Error('Unsupported source cell type.');
    }
    function sheets() {
      var result = {};
      required.concat(optional).forEach(function(name) {
        stage = 'sheet-' + name;
        var sheet = ss.getSheetByName(name);
        if (!sheet) {
          if (required.indexOf(name) >= 0) throw new Error('Required migration sheet missing.');
          return;
        }
        var rows = sheet.getLastRow(), cols = sheet.getLastColumn();
        result[name] = {rows:rows, columns:cols,
          values:rows && cols ? sheet.getRange(1,1,rows,cols).getValues().map(function(row) {
            return row.map(normalize);
          }) : []};
      });
      return result;
    }
    function properties(all) {
      var captured = {}, omittedNames = [];
      Object.keys(all).sort().forEach(function(key) {
        // Authentication values have their own secret-transfer procedure.
        // An unknown property is reported by name for review, not silently lost.
        if (/^(RAW_REPORT_|REPORT_ADMISSION_|REPORT_SUBMISSION_|REPORT_INACTIVITY_|REPORT_PUBLICATION_|REPORT_CURRENT_D1_|REPORT_HISTORY_|REPORT_DISTRIBUTION_|REPORT_POST_COMMIT_|REPORT_MAINTENANCE_|REPORT_PSYCHOLOGY_|REPORT_STATE_D1_|REPORTS_D1_)/.test(key))
          captured[key] = String(all[key]);
        else omittedNames.push(key);
      });
      return {captured:captured, omittedNames:omittedNames};
    }
    var before = sheets();
    var after = sheets();
    stage = 'consistency';
    var first = properties(initialProperties), second = properties(props.getProperties());
    if (JSON.stringify(before) !== JSON.stringify(after) ||
        JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error('Apps Script source changed during frozen capture.');
    }
    return {captureId:request.captureId, preliminary:request.preliminary === true, sheets:before, properties:first.captured,
      omittedPropertyNames:first.omittedNames,
      sheetNames:ss.getSheets().map(function(sheet) {return sheet.getName();}).sort()};
  } catch (_) {
    // Do not forward Google errors containing sheet data or private identifiers.
    throw new Error('Frozen Apps Script capture failed; stage=' + stage + '; inspect source completeness.');
  } finally { lock.releaseLock(); }
}
