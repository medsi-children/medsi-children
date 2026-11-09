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

// The only supported production schema preparation. Existing installations
// and newly created historical snapshots converge to the same 26-table model.
export async function prepareCurrentChildSchema(sql){
  // Ownership preparation is required for safe access. Physical cleanup may
  // be deferred if locks are busy or an old row needs manual review.
  await ensureCurrentChildColumns(sql);
  try{return await retireHospitalAdmissions(sql)}
  catch{return {ok:true,retired:false,deferred:true}}
}
