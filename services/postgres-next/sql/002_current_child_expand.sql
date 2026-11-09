-- EXPAND phase, MANUAL ONLY. Never run during application startup.
-- Take and RESTORE-TEST an encrypted Timeweb backup before executing.
-- Existing application keeps using the old fields until every live service
-- has been ported to the registered child identity model.
BEGIN;
ALTER TABLE parent_current_reports ADD COLUMN IF NOT EXISTS child_id TEXT NOT NULL DEFAULT '';
ALTER TABLE parent_report_history ADD COLUMN IF NOT EXISTS child_id TEXT NOT NULL DEFAULT '';

-- Infer ownership ONLY when both the existing parent profile and the old
-- hospital link agree. Any ambiguity remains blank and inaccessible in v2.
UPDATE parent_current_reports AS r
SET child_id = p.child_id
FROM parent_profiles AS p
INNER JOIN admissions AS a ON a.admission_id=p.admission_id
  AND a.child_id=p.child_id AND a.status='active'
WHERE r.phone10=p.phone10 AND r.admission_id=p.admission_id
  AND p.child_id<>'' AND r.child_id='';

UPDATE parent_report_history AS r
SET child_id = p.child_id
FROM parent_profiles AS p
INNER JOIN admissions AS a ON a.admission_id=p.admission_id
  AND a.child_id=p.child_id AND a.status='active'
WHERE r.phone10=p.phone10 AND r.admission_id=p.admission_id
  AND p.child_id<>'' AND r.child_id='';

CREATE INDEX IF NOT EXISTS parent_current_by_child
  ON parent_current_reports (child_id,phone10);
CREATE INDEX IF NOT EXISTS parent_history_by_child
  ON parent_report_history (child_id,phone10,report_date DESC);
COMMIT;

-- IMPORTANT: do not auto-populate the remaining blank child_id rows by name.
-- Export only aggregate counts for a manual migration review, no PHI logs:
-- SELECT COUNT(*) FROM parent_current_reports WHERE kind IN ('morning','evening') AND child_id='';
-- SELECT COUNT(*) FROM parent_report_history WHERE kind IN ('morning','evening') AND child_id='';
