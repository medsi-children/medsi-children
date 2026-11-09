-- OPTIONAL ONE-TIME SCHEMA CLEANUP: after the admission-free app is live.
-- The entire operation is DDL-only. No source reports, parent profiles,
-- messages, child records or ownership guards are deleted by this script.
-- PostgreSQL will take a short exclusive lock while dropping obsolete fields.
-- This is intentionally NOT run by application startup.
BEGIN;
-- Refuse to discard evidence needed to attribute an existing individual
-- report to its currently registered child.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM parent_current_reports r
    JOIN parent_profiles p ON p.phone10=r.phone10
    WHERE r.kind IN ('morning','evening') AND p.child_id<>''
      AND r.child_id='' AND r.admission_id=p.admission_id
  ) OR EXISTS (
    SELECT 1 FROM parent_report_history r
    JOIN parent_profiles p ON p.phone10=r.phone10
    WHERE r.kind IN ('morning','evening') AND p.child_id<>''
      AND r.child_id='' AND r.admission_id=p.admission_id
  ) THEN
    RAISE EXCEPTION 'Verified child_id backfill incomplete; no schema changed';
  END IF;
END $$;
ALTER TABLE parent_profiles DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_registration_attempts DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_current_reports DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_report_history DROP COLUMN IF EXISTS admission_id;
ALTER TABLE parent_deletion_queue DROP COLUMN IF EXISTS admission_id;
DROP TABLE IF EXISTS admissions;
COMMIT;
