import { createHash } from 'node:crypto';

const KINDS = new Set(['morning', 'evening', 'psychology']);
const PHONE = /^\d{10}$/;
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const LIMIT = 240000;

export function createEducatorReportEditsStore(sql) {
  if (!sql?.begin) throw new Error('PostgreSQL query client required.');
  return {
    async update(input) {
      const phone10 = String(input?.phone10 || '');
      const admissionId = String(input?.admissionId || '');
      const kind = String(input?.kind || '');
      const text = input?.text;
      if (!PHONE.test(phone10) || !ID.test(admissionId) || !KINDS.has(kind) ||
          typeof text !== 'string' || text.length > LIMIT) {
        throw new Error('Invalid distributed report edit.');
      }
      return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async tx => {
        const [[profile]] = await tx`
          SELECT p.phone10, p.admission_id, a.status
          FROM parent_profiles p JOIN admissions a ON a.admission_id=p.admission_id
          WHERE p.phone10=${phone10} AND p.admission_id=${admissionId}
            AND p.child_id=a.child_id AND a.status=${'active'}`;
        if (!profile) throw new Error('Report recipient is no longer active.');
        const [[current]] = await tx`
          SELECT publication_id, revision, text FROM parent_current_reports
          WHERE phone10=${phone10} AND kind=${kind} AND admission_id=${admissionId} FOR UPDATE`;
        if (!current) throw new Error('Distributed report not found.');
        const version = createHash('sha256').update(kind+'\u0000'+admissionId+'\u0000'+text,'utf8').digest('hex');
        const now = BigInt(Date.now());
        await tx`UPDATE parent_current_reports SET text=${text}, version=${version}, read_version=${''}, updated_at=${now}
          WHERE phone10=${phone10} AND kind=${kind} AND admission_id=${admissionId}`;
        const [[raw]] = await tx`SELECT report_date FROM raw_reports WHERE publication_id=${current.publication_id}`;
        if (raw?.report_date) {
          await tx.upsert`INSERT INTO parent_report_history
            (phone10,kind,report_date,admission_id,publication_id,revision,text,captured_at)
            VALUES (${phone10},${kind},${raw.report_date},${admissionId},${current.publication_id},${current.revision},${text},${now})`;
        }
        return { ok: true, version };
      });
    }
  };
}
