-- MEDSI NEXT PostgreSQL 17 schema, derived from YDB NEXT data model.
-- APPLY ONLY TO AN EMPTY, EXPLICITLY APPROVED DATABASE.
-- All timestamps are UTC Unix milliseconds; IDs and phones are opaque text.
-- Sensitive clinical data must never appear in migration logs or GitHub Actions.

CREATE TABLE IF NOT EXISTS children (
  child_id TEXT NOT NULL,
  registered_first_name TEXT,
  surname TEXT,
  created_at BIGINT,
  PRIMARY KEY (child_id)
);
CREATE TABLE IF NOT EXISTS admissions (
  admission_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  status TEXT,
  admitted_at BIGINT,
  discharged_at BIGINT,
  PRIMARY KEY (admission_id)
);
CREATE TABLE IF NOT EXISTS parent_profiles (
  phone10 TEXT NOT NULL,
  parent_name TEXT,
  child_name TEXT,
  relationship TEXT,
  child_id TEXT,
  admission_id TEXT,
  profile_generation TEXT,
  child_genitive TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS name_variants (
  base_key TEXT NOT NULL,
  preferred_name TEXT,
  variants_json TEXT,
  updated_at BIGINT,
  PRIMARY KEY (base_key)
);
CREATE TABLE IF NOT EXISTS report_publication_head (
  kind TEXT NOT NULL,
  publication_id TEXT,
  revision BIGINT,
  submitted_at BIGINT,
  PRIMARY KEY (kind)
);
CREATE TABLE IF NOT EXISTS report_submissions (
  submission_id TEXT NOT NULL,
  kind TEXT,
  payload_hash TEXT,
  publication_id TEXT,
  submitted_at BIGINT,
  revision BIGINT,
  PRIMARY KEY (submission_id)
);
CREATE TABLE IF NOT EXISTS raw_reports (
  publication_id TEXT NOT NULL,
  kind TEXT,
  report_date TEXT,
  raw_text TEXT,
  normalized_text TEXT,
  author_id TEXT,
  submitted_at BIGINT,
  revision BIGINT,
  PRIMARY KEY (publication_id)
);
CREATE TABLE IF NOT EXISTS report_ownership (
  owner_key TEXT NOT NULL,
  record_json TEXT,
  updated_at BIGINT,
  PRIMARY KEY (owner_key)
);
CREATE TABLE IF NOT EXISTS parent_current_reports (
  phone10 TEXT NOT NULL,
  kind TEXT NOT NULL,
  admission_id TEXT,
  publication_id TEXT,
  revision BIGINT,
  text TEXT,
  version TEXT,
  read_version TEXT,
  updated_at BIGINT,
  PRIMARY KEY (phone10, kind)
);
CREATE TABLE IF NOT EXISTS parent_report_history (
  phone10 TEXT NOT NULL,
  kind TEXT NOT NULL,
  report_date TEXT NOT NULL,
  admission_id TEXT,
  publication_id TEXT,
  revision BIGINT,
  text TEXT,
  captured_at BIGINT,
  PRIMARY KEY (phone10, kind, report_date)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  phone10 TEXT NOT NULL,
  message_key TEXT NOT NULL,
  client_message_id TEXT,
  side TEXT,
  type TEXT,
  text TEXT,
  file_id TEXT,
  reply_to_key TEXT,
  reaction TEXT,
  status TEXT,
  created_at BIGINT,
  edited_at BIGINT,
  delete_after BIGINT,
  read_by_parent BOOLEAN,
  read_by_educator BOOLEAN,
  PRIMARY KEY (phone10, message_key)
);
CREATE TABLE IF NOT EXISTS chat_media (
  file_id TEXT NOT NULL,
  phone10 TEXT,
  uploaded_at BIGINT,
  PRIMARY KEY (file_id)
);
CREATE TABLE IF NOT EXISTS chat_thread_state (
  phone10 TEXT NOT NULL,
  last_message_key TEXT,
  last_side TEXT,
  last_type TEXT,
  last_text TEXT,
  last_at BIGINT,
  educator_has_unread BOOLEAN,
  parent_has_unread BOOLEAN,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS chat_message_dedup (
  phone10 TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  message_key TEXT,
  payload_hash TEXT,
  created_at BIGINT,
  PRIMARY KEY (phone10, client_message_id)
);
CREATE TABLE IF NOT EXISTS chat_pins (
  phone10 TEXT NOT NULL,
  bucket TEXT,
  updated_at BIGINT,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  token_hash TEXT NOT NULL,
  role TEXT,
  phone10 TEXT,
  profile_generation TEXT,
  expires_at BIGINT,
  created_at BIGINT,
  PRIMARY KEY (token_hash)
);
CREATE TABLE IF NOT EXISTS parent_auth_profiles (
  phone10 TEXT NOT NULL,
  user_handle TEXT,
  generation_id TEXT,
  created_at BIGINT,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS parent_passkeys (
  credential_id TEXT NOT NULL,
  user_handle TEXT,
  public_key BYTEA,
  counter BIGINT,
  transports_json TEXT,
  device_type TEXT,
  backed_up BOOLEAN,
  created_at BIGINT,
  revoked_at BIGINT,
  PRIMARY KEY (credential_id)
);
CREATE TABLE IF NOT EXISTS parent_auth_challenges (
  challenge_id TEXT NOT NULL,
  challenge TEXT,
  purpose TEXT,
  phone10 TEXT,
  user_handle TEXT,
  generation_id TEXT,
  created_at BIGINT,
  expires_at BIGINT,
  consumed_at BIGINT,
  PRIMARY KEY (challenge_id)
);
CREATE TABLE IF NOT EXISTS parent_deletion_queue (
  operation_id TEXT NOT NULL,
  phone10 TEXT,
  parent_name TEXT,
  child_id TEXT,
  admission_id TEXT,
  profile_generation TEXT,
  status TEXT,
  attempts BIGINT,
  last_error TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (operation_id)
);
CREATE TABLE IF NOT EXISTS parent_registration_attempts (
  attempt_id TEXT NOT NULL,
  phone10 TEXT,
  parent_name TEXT,
  child_name TEXT,
  status TEXT,
  child_id TEXT,
  admission_id TEXT,
  approved_by TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  PRIMARY KEY (attempt_id)
);
CREATE TABLE IF NOT EXISTS parent_access_requests (
  request_id TEXT NOT NULL,
  phone10 TEXT,
  request_secret_hash TEXT,
  status TEXT,
  decision TEXT,
  created_at BIGINT,
  updated_at BIGINT,
  expires_at BIGINT,
  PRIMARY KEY (request_id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT NOT NULL,
  role TEXT,
  phone10 TEXT,
  subscription_json TEXT,
  enabled BOOLEAN,
  updated_at BIGINT,
  PRIMARY KEY (subscription_id)
);
CREATE TABLE IF NOT EXISTS push_outbox (
  event_id TEXT NOT NULL,
  role TEXT,
  phone10 TEXT,
  notification_json TEXT,
  status TEXT,
  attempts BIGINT,
  next_attempt_at BIGINT,
  created_at BIGINT,
  PRIMARY KEY (event_id)
);
CREATE TABLE IF NOT EXISTS background_jobs (
  job_id TEXT NOT NULL,
  job_type TEXT,
  payload_json TEXT,
  status TEXT,
  attempts BIGINT,
  next_attempt_at BIGINT,
  created_at BIGINT,
  PRIMARY KEY (job_id)
);
CREATE TABLE IF NOT EXISTS migration_state (
  stream_id TEXT NOT NULL,
  cursor_value TEXT,
  source_count BIGINT,
  destination_count BIGINT,
  source_digest TEXT,
  destination_digest TEXT,
  verified_at BIGINT,
  PRIMARY KEY (stream_id)
);
CREATE TABLE IF NOT EXISTS stand_bootstrap_state (
  bootstrap_id TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at BIGINT,
  PRIMARY KEY (bootstrap_id)
);

CREATE INDEX IF NOT EXISTS chat_messages_by_time ON chat_messages (phone10, created_at DESC, message_key DESC);
CREATE INDEX IF NOT EXISTS chat_messages_by_key ON chat_messages (message_key);
CREATE INDEX IF NOT EXISTS chat_messages_by_file ON chat_messages (file_id);
CREATE INDEX IF NOT EXISTS parent_deletion_queue_by_phone ON parent_deletion_queue (phone10);
CREATE INDEX IF NOT EXISTS push_outbox_by_due ON push_outbox (status, next_attempt_at);
