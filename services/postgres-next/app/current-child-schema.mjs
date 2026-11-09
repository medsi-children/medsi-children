// One-time, additive compatibility update for the admission-free model.
// The existing admissions table is never modified or removed. An already
// verified profile/report association gets its child_id; ambiguous rows stay
// unassigned. Re-running the operation is harmless.
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
