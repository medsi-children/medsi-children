// One-time, additive compatibility update for the admission-free model.
// Admission data is read only to rescue verified old report ownership before
// retirement. Unknown assignments remain unassigned. This stage is idempotent.
export async function ensureCurrentChildColumns(sql){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    await tx`ALTER TABLE parent_current_reports
      ADD COLUMN IF NOT EXISTS child_id TEXT NOT NULL DEFAULT ''`;
    await tx`ALTER TABLE parent_report_history
      ADD COLUMN IF NOT EXISTS child_id TEXT NOT NULL DEFAULT ''`;
    const [[relation]]=await tx`SELECT to_regclass(${'public.admissions'}) AS admissions`;
    if(relation?.admissions){
      // Only exact, active old links are trusted for already published reports.
      // An orphan or conflicting clinical report must not be claimed by name.
      await tx`UPDATE parent_current_reports AS r
        SET child_id=p.child_id
        FROM parent_profiles AS p
        INNER JOIN admissions AS a ON a.admission_id=p.admission_id
          AND a.child_id=p.child_id AND a.status=${'active'}
        WHERE r.phone10=p.phone10 AND r.admission_id=p.admission_id
          AND p.child_id<>${''} AND r.child_id=${''}`;
      await tx`UPDATE parent_report_history AS r
        SET child_id=p.child_id
        FROM parent_profiles AS p
        INNER JOIN admissions AS a ON a.admission_id=p.admission_id
          AND a.child_id=p.child_id AND a.status=${'active'}
        WHERE r.phone10=p.phone10 AND r.admission_id=p.admission_id
          AND p.child_id<>${''} AND r.child_id=${''}`;
    }
    return {ok:true};
  });
}

// The live app uses child_id and no longer calls any admission-based service.
// Keep this schema contraction separate from identity backfill so a busy
// database can skip the cleanup without taking parent services offline.
// This transaction changes only five obsolete columns and one obsolete table.
export async function retireHospitalAdmissions(sql){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    // Avoid stalling parent-facing requests behind a long metadata lock.
    await tx`SET LOCAL lock_timeout = '5s'`;
    const [[before]]=await tx`SELECT to_regclass(${'public.admissions'}) AS admissions`;
    if(before?.admissions){
      // Active verified parent/report ownership must be copied to child_id
      // before dropping its old join key. Ambiguity halts the transaction.
      const [[result]]=await tx`SELECT EXISTS (
        SELECT 1 FROM parent_current_reports r
          JOIN parent_profiles p ON p.phone10=r.phone10
        WHERE r.kind IN ('morning','evening')
          AND p.child_id<>${''} AND r.child_id=${''}
          AND r.admission_id=p.admission_id
        UNION ALL
        SELECT 1 FROM parent_report_history r
          JOIN parent_profiles p ON p.phone10=r.phone10
        WHERE r.kind IN ('morning','evening')
          AND p.child_id<>${''} AND r.child_id=${''}
          AND r.admission_id=p.admission_id
      ) AS unmigrated`;
      if(result?.unmigrated)
        throw new Error('Verified child report ownership is not migrated.');
    }
    await tx`ALTER TABLE parent_profiles DROP COLUMN IF EXISTS admission_id`;
    await tx`ALTER TABLE parent_registration_attempts DROP COLUMN IF EXISTS admission_id`;
    await tx`ALTER TABLE parent_current_reports DROP COLUMN IF EXISTS admission_id`;
    await tx`ALTER TABLE parent_report_history DROP COLUMN IF EXISTS admission_id`;
    await tx`ALTER TABLE parent_deletion_queue DROP COLUMN IF EXISTS admission_id`;
    await tx`DROP TABLE IF EXISTS admissions`;
    return {ok:true,retired:Boolean(before?.admissions)};
  });
}

// Independent parent directory. No foreign keys to current children/profiles:
// ordinary discharge deletes active access but leaves this historical record.
export async function ensureParentDirectoryArchive(sql){
  if(!sql?.begin)throw new Error('PostgreSQL required.');
  return sql.begin({isolation:'serializableReadWrite',idempotent:true},async tx=>{
    await tx`CREATE TABLE IF NOT EXISTS parent_directory_archive (
      entry_id TEXT PRIMARY KEY,
      phone10 TEXT NOT NULL,
      parent_name TEXT NOT NULL,
      child_name TEXT NOT NULL,
      child_surname TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      registered_at BIGINT,
      created_at BIGINT NOT NULL
    )`;
    // Existing records may have been imported before phone deduplication.
    // Keep the oldest richer legacy row when available, otherwise the newest
    // registration. This migration only touches the independent archive.
    await tx`LOCK TABLE parent_directory_archive IN SHARE ROW EXCLUSIVE MODE`;
    await tx`WITH ranked AS (
      SELECT entry_id, ROW_NUMBER() OVER (
        PARTITION BY phone10 ORDER BY
          CASE WHEN source=${'legacy_import'} THEN 0
               WHEN source=${'registration'} THEN 1 ELSE 2 END,
          LENGTH(child_surname) DESC, created_at DESC, entry_id DESC
      ) AS duplicate_rank FROM parent_directory_archive
    ) DELETE FROM parent_directory_archive AS archive
      USING ranked WHERE archive.entry_id=ranked.entry_id
        AND ranked.duplicate_rank>1`;
    // Retain the existing index name so schema probes and deployments stay
    // compatible, but enforce the one-phone rule in PostgreSQL itself.
    const [[index]]=await tx`SELECT indexdef FROM pg_indexes
      WHERE schemaname=${'public'} AND indexname=${'parent_directory_phone_idx'}`;
    if(index&&!/CREATE UNIQUE INDEX/i.test(String(index.indexdef||'')))
      await tx`DROP INDEX IF EXISTS parent_directory_phone_idx`;
    await tx`CREATE UNIQUE INDEX IF NOT EXISTS parent_directory_phone_idx
      ON parent_directory_archive (phone10)`;

    // One-time snapshot of parents admitted before this directory existed.
    // The marker prevents a deliberate archive deletion from being undone
    // on the next app restart. Subsequent registrations write themselves.
    const marker='parent_directory_active_seed_v1';
    const [newMarker]=await tx`INSERT INTO migration_state (stream_id,cursor_value)
      VALUES (${marker},${'seeded'}) ON CONFLICT (stream_id) DO NOTHING
      RETURNING stream_id`;
    if(newMarker.length){
      await tx`INSERT INTO parent_directory_archive
        (entry_id,phone10,parent_name,child_name,child_surname,source,registered_at,created_at)
        SELECT ${'current_'}||p.phone10, p.phone10, p.parent_name,
          COALESCE(NULLIF(c.registered_first_name,${''}),p.child_name),
          COALESCE(c.surname,${''}), ${'current_profile'}, p.created_at,
          p.created_at
        FROM parent_profiles AS p
        LEFT JOIN children AS c ON c.child_id=p.child_id
        WHERE LENGTH(p.phone10)=10
        ON CONFLICT (phone10) DO NOTHING`;
    }
    return {ok:true};
  });
}

// The only supported production schema preparation. Existing installations
// and newly created historical snapshots converge to the same 26-table model.
export async function prepareCurrentChildSchema(sql){
  // Ownership preparation is required for safe access. Physical cleanup may
  // be deferred if locks are busy or an old row needs manual review.
  await ensureCurrentChildColumns(sql);
  await ensureParentDirectoryArchive(sql);
  try{return await retireHospitalAdmissions(sql)}
  catch{return {ok:true,retired:false,deferred:true}}
}
