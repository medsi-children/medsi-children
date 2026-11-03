-- MEDSI NEXT / proposed YDB Serverless schema. Apply only to a NEW TEST database.
-- No production migration is performed by adding this file.
-- Utf8 identifiers are stable opaque IDs; times are Unix milliseconds (Uint64).
CREATE TABLE IF NOT EXISTS children (
  child_id Utf8 NOT NULL,
  registered_first_name Utf8,
  surname Utf8,
  created_at Uint64,
  PRIMARY KEY (child_id)
);
CREATE TABLE IF NOT EXISTS admissions (
  admission_id Utf8 NOT NULL,
  child_id Utf8 NOT NULL,
  status Utf8,
  admitted_at Uint64,
  discharged_at Uint64,
  PRIMARY KEY (admission_id)
);
CREATE TABLE IF NOT EXISTS parent_profiles (
  phone10 Utf8 NOT NULL,
  parent_name Utf8,
  relationship Utf8,
  child_id Utf8,
  admission_id Utf8,
  profile_generation Utf8,
  child_genitive Utf8,
  created_at Uint64,
  updated_at Uint64,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS name_variants (
  base_key Utf8 NOT NULL,
  preferred_name Utf8,
  variants_json Utf8,
  updated_at Uint64,
  PRIMARY KEY (base_key)
);
CREATE TABLE IF NOT EXISTS report_publication_head (
  kind Utf8 NOT NULL,
  publication_id Utf8,
  revision Uint64,
  submitted_at Uint64,
  PRIMARY KEY (kind)
);
CREATE TABLE IF NOT EXISTS report_submissions (
  submission_id Utf8 NOT NULL,
  kind Utf8,
  payload_hash Utf8,
  publication_id Utf8,
  submitted_at Uint64,
  revision Uint64,
  PRIMARY KEY (submission_id)
);
CREATE TABLE IF NOT EXISTS raw_reports (
  publication_id Utf8 NOT NULL,
  kind Utf8,
  report_date Utf8,
  raw_text Utf8,
  normalized_text Utf8,
  author_id Utf8,
  submitted_at Uint64,
  revision Uint64,
  PRIMARY KEY (publication_id)
);
CREATE TABLE IF NOT EXISTS report_ownership (
  owner_key Utf8 NOT NULL,
  record_json Utf8,
  updated_at Uint64,
  PRIMARY KEY (owner_key)
);
CREATE TABLE IF NOT EXISTS parent_current_reports (
  phone10 Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  admission_id Utf8,
  publication_id Utf8,
  revision Uint64,
  text Utf8,
  version Utf8,
  read_version Utf8,
  updated_at Uint64,
  PRIMARY KEY (phone10, kind)
);
CREATE TABLE IF NOT EXISTS parent_report_history (
  phone10 Utf8 NOT NULL,
  kind Utf8 NOT NULL,
  report_date Utf8 NOT NULL,
  admission_id Utf8,
  publication_id Utf8,
  revision Uint64,
  text Utf8,
  captured_at Uint64,
  PRIMARY KEY (phone10, kind, report_date)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  phone10 Utf8 NOT NULL,
  message_key Utf8 NOT NULL,
  client_message_id Utf8,
  side Utf8,
  type Utf8,
  text Utf8,
  file_id Utf8,
  reply_to_key Utf8,
  reaction Utf8,
  status Utf8,
  created_at Uint64,
  edited_at Uint64,
  delete_after Uint64,
  read_by_parent Bool,
  read_by_educator Bool,
  INDEX chat_messages_by_time GLOBAL ON (phone10, created_at),
  INDEX chat_messages_by_key GLOBAL ON (message_key),
  PRIMARY KEY (phone10, message_key)
);
CREATE TABLE IF NOT EXISTS chat_thread_state (
  phone10 Utf8 NOT NULL,
  last_message_key Utf8,
  last_side Utf8,
  last_type Utf8,
  last_text Utf8,
  last_at Uint64,
  educator_has_unread Bool,
  parent_has_unread Bool,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS chat_message_dedup (
  phone10 Utf8 NOT NULL,
  client_message_id Utf8 NOT NULL,
  message_key Utf8,
  payload_hash Utf8,
  created_at Uint64,
  PRIMARY KEY (phone10, client_message_id)
);
CREATE TABLE IF NOT EXISTS chat_pins (
  phone10 Utf8 NOT NULL,
  bucket Utf8,
  updated_at Uint64,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  token_hash Utf8 NOT NULL,
  role Utf8,
  phone10 Utf8,
  profile_generation Utf8,
  expires_at Uint64,
  created_at Uint64,
  PRIMARY KEY (token_hash)
);
CREATE TABLE IF NOT EXISTS parent_auth_profiles (
  phone10 Utf8 NOT NULL,
  user_handle Utf8,
  generation_id Utf8,
  PRIMARY KEY (phone10)
);
CREATE TABLE IF NOT EXISTS parent_passkeys (
  credential_id Utf8 NOT NULL,
  user_handle Utf8,
  public_key String,
  counter Uint64,
  transports_json Utf8,
  device_type Utf8,
  backed_up Bool,
  created_at Uint64,
  revoked_at Uint64,
  PRIMARY KEY (credential_id)
);
CREATE TABLE IF NOT EXISTS parent_auth_challenges (
  challenge_id Utf8 NOT NULL,
  challenge Utf8,
  purpose Utf8,
  phone10 Utf8,
  user_handle Utf8,
  generation_id Utf8,
  created_at Uint64,
  expires_at Uint64,
  consumed_at Uint64,
  PRIMARY KEY (challenge_id)
);
CREATE TABLE IF NOT EXISTS parent_deletion_queue (
  operation_id Utf8 NOT NULL,
  phone10 Utf8,
  parent_name Utf8,
  child_id Utf8,
  admission_id Utf8,
  profile_generation Utf8,
  status Utf8,
  attempts Uint64,
  last_error Utf8,
  created_at Uint64,
  updated_at Uint64,
  PRIMARY KEY (operation_id)
);
CREATE TABLE IF NOT EXISTS parent_registration_attempts (
  attempt_id Utf8 NOT NULL,
  phone10 Utf8,
  parent_name Utf8,
  child_name Utf8,
  status Utf8,
  child_id Utf8,
  admission_id Utf8,
  approved_by Utf8,
  created_at Uint64,
  updated_at Uint64,
  PRIMARY KEY (attempt_id)
);
CREATE TABLE IF NOT EXISTS parent_access_requests (
  request_id Utf8 NOT NULL,
  phone10 Utf8,
  request_secret_hash Utf8,
  status Utf8,
  decision Utf8,
  created_at Uint64,
  updated_at Uint64,
  expires_at Uint64,
  PRIMARY KEY (request_id)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id Utf8 NOT NULL,
  role Utf8,
  phone10 Utf8,
  subscription_json Utf8,
  enabled Bool,
  updated_at Uint64,
  PRIMARY KEY (subscription_id)
);
CREATE TABLE IF NOT EXISTS push_outbox (
  event_id Utf8 NOT NULL,
  role Utf8,
  phone10 Utf8,
  notification_json Utf8,
  status Utf8,
  attempts Uint64,
  next_attempt_at Uint64,
  created_at Uint64,
  PRIMARY KEY (event_id)
);
CREATE TABLE IF NOT EXISTS background_jobs (
  job_id Utf8 NOT NULL,
  job_type Utf8,
  payload_json Utf8,
  status Utf8,
  attempts Uint64,
  next_attempt_at Uint64,
  created_at Uint64,
  PRIMARY KEY (job_id)
);
CREATE TABLE IF NOT EXISTS migration_state (
  stream_id Utf8 NOT NULL,
  cursor_value Utf8,
  source_count Uint64,
  destination_count Uint64,
  source_digest Utf8,
  destination_digest Utf8,
  verified_at Uint64,
  PRIMARY KEY (stream_id)
);
