-- FINAL CONTRACT, MANUAL ONLY: run exclusively after:
-- (1) encrypted backup restored and verified;
-- (2) 002_current_child_expand.sql applied and dry-run validated;
-- (3) all parent, educator, report, edit, S3 and deletion services are running
--     MEDSI_CURRENT_CHILD_MODEL=1 and pass synthetic acceptance tests;
-- (4) a maintenance window with writes disabled and a rollback plan.
-- No script auto-executes this file from application startup.
BEGIN;

-- Do not throw away currently assigned patient reports. The review must
-- explicitly fix or quarantine every active row with missing child_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM parent_current_reports r
    JOIN parent_profiles p ON p.phone10=r.phone10
    WHERE r.kind IN ('morning','evening') AND p.child_id<>''
      AND r.child_id='' AND r.admission_id=p.admission_id
  ) THEN
    RAISE EXCEPTION 'Unmigrated current report ownership: manual review required';
  END IF;
END $$;

-- Remove inaccessible legacy individual records, never touch raw_reports
-- (staff source texts may contain multiple children and must stay intact).
DELETE FROM parent_current_reports
  WHERE kind IN ('morning','evening') AND child_id='';
DELETE FROM parent_report_history
  WHERE kind IN ('morning','evening') AND child_id='';

-- The LAST registered parent is the sole lifetime owner of child rows.
-- No unregistered or discharged patient archive remains in operational roster.
DELETE FROM children c
WHERE NOT EXISTS (SELECT 1 FROM parent_profiles p WHERE p.child_id=c.child_id);

-- Historical raw-source ownership used admission IDs and personal deletion
-- fences. New source ownership is scoped to CURRENT_BLOCK_<publication>_<index>.
-- Old pre-cutover raw publications must be excluded from new backfill.
DELETE FROM report_ownership
  WHERE owner_key LIKE 'RAW_REPORT_OWNER_%'
     OR owner_key LIKE 'DELETED_SOURCE_%';

ALTER TABLE parent_profiles DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_registration_attempts DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_current_reports DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_report_history DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_deletion_queue DROP COLUMN IF EXISTS admission_id;

DROP TABLE IF EXISTS admissions;
COMMIT;

-- Read-only postcondition:
-- SELECT to_regclass('public.admissions') IS NULL AS no_admissions;
-- SELECT COUNT(*) FROM children c WHERE NOT EXISTS
--   (SELECT 1 FROM parent_profiles p WHERE p.child_id=c.child_id);
