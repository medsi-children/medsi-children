import { createHash, randomUUID } from 'node:crypto';
import { Uint64 } from '@ydbjs/value/primitive';

const ALLOWED_KINDS = new Set(['morning', 'evening', 'psychology']);
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const PHONE_RE = /^\d{10}$/;
const TEXT_LIMIT = 240000;

function sha(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function moscowDate(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp));
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

// The legacy Apps Script distribution algorithm must run BEFORE this function.
// Fail closed on unknown/incomplete recipients: never guess which child owns text.
export function prepareReportPublication(input) {
  if (!input || typeof input !== 'object') throw new Error('Report payload is required.');
  const kind = String(input.kind || '');
  const submissionId = String(input.submissionId || '');
  const authorId = String(input.authorId || '');
  const rawText = String(input.rawText || '');
  const normalizedText = String(input.normalizedText || '');
  const submittedAt = Number(input.submittedAt);
  if (!ALLOWED_KINDS.has(kind)) throw new Error('Unsupported report type.');
  if (!ID_RE.test(submissionId) || !ID_RE.test(authorId)) throw new Error('Invalid submission/author identifier.');
  if (!Number.isSafeInteger(submittedAt) || submittedAt <= 0 || submittedAt > Date.now() + 60000) {
    throw new Error('Invalid report submission time.');
  }
  if (!rawText.trim() || !normalizedText.trim() || rawText.length > TEXT_LIMIT || normalizedText.length > TEXT_LIMIT) {
    throw new Error('Empty or oversized report.');
  }
  if (!Array.isArray(input.recipients) || input.recipients.length === 0 || input.recipients.length > 200) {
    throw new Error('Expected full recipient roster (1–200 entries).');
  }
  const phones = new Set();
  const recipients = input.recipients.map(row => {
    const phone10 = String(row.phone10 || '');
    const admissionId = String(row.admissionId || '');
    const text = String(row.text ?? '');
    if (!PHONE_RE.test(phone10) || !ID_RE.test(admissionId) || text.length > TEXT_LIMIT || phones.has(phone10)) {
      throw new Error('Ambiguous or invalid recipient. Publication aborted.');
    }
    phones.add(phone10);
    return { phone10, admissionId, text };
  });
  return {
    kind, submissionId, authorId, submittedAt, rawText, normalizedText,
    recipients, reportDate: moscowDate(submittedAt),
    payloadHash: sha(kind + '\u0000' + rawText)
  };
}

function safeTextVersion(kind, admissionId, text) {
  return sha(kind + '\u0000' + admissionId + '\u0000' + text);
}

// sql is the official @ydbjs/query tagged-template client; injectable in tests.
// No HTTP route or production wiring exists yet.
export function createReportPublicationStore(sql) {
  if (!sql || typeof sql.begin !== 'function') throw new Error('YDB query client required.');
  return {
    async publishPrepared(input) {
      const payload = prepareReportPublication(input);
      const {
        kind, submissionId, authorId, submittedAt, rawText, normalizedText,
        recipients, reportDate, payloadHash
      } = payload;

      // Serializable transaction includes roster validation, idempotency, raw source,
      // parent reports, history and push outbox. No external push inside transaction.
      return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async tx => {
        const [oldSubmission] = await tx`
          SELECT kind, payload_hash, publication_id, revision
          FROM report_submissions WHERE submission_id = ${submissionId}`;
        if (oldSubmission) {
          if (oldSubmission.kind !== kind || oldSubmission.payload_hash !== payloadHash) {
            throw new Error('Submission ID already belongs to a different report.');
          }
          return {
            status: 'duplicate', submissionId, publicationId: oldSubmission.publication_id,
            revision: Number(oldSubmission.revision)
          };
        }

        // Match the ENTIRE active parent roster. If anyone registers, changes admission
        // or is discharged while distribution runs, abort instead of misrouting text.
        const activeProfiles = await tx`
          SELECT phone10, admission_id FROM parent_profiles`;
        const expected = new Map(recipients.map(row => [row.phone10, row.admissionId]));
        if (activeProfiles.length !== expected.size ||
            activeProfiles.some(row => expected.get(row.phone10) !== row.admission_id)) {
          throw new Error('Parent roster changed during report preparation; retry distribution.');
        }

        const [head] = await tx`
          SELECT publication_id, revision, submitted_at
          FROM report_publication_head WHERE kind = ${kind}`;
        if (head && submittedAt <= Number(head.submitted_at)) {
          // Superseded reports do not write raw/current/history or queue push.
          return { status: 'superseded', submissionId };
        }

        const publicationId = randomUUID();
        const revision = Number(head?.revision || 0) + 1;
        if (!Number.isSafeInteger(revision)) throw new Error('Report revision overflow.');
        const timeParam = new Uint64(BigInt(submittedAt));
        const revisionParam = new Uint64(BigInt(revision));
        const zeroParam = new Uint64(0n);

        await tx`UPSERT INTO raw_reports
          (publication_id, kind, report_date, raw_text, normalized_text, author_id, submitted_at, revision)
          VALUES (${publicationId}, ${kind}, ${reportDate}, ${rawText}, ${normalizedText},
                  ${authorId}, ${timeParam}, ${revisionParam})`;

        const notifications = [];
        for (const row of recipients) {
          const phone10 = row.phone10;
          const admissionId = row.admissionId;
          const text = row.text;
          const version = safeTextVersion(kind, admissionId, text);
          const [prior] = await tx`
            SELECT admission_id, version, read_version, text
            FROM parent_current_reports WHERE phone10 = ${phone10} AND kind = ${kind}`;
          const unchanged = prior && prior.version === version && prior.admission_id === admissionId;
          const readVersion = unchanged ? String(prior.read_version || '') : '';

          await tx`UPSERT INTO parent_current_reports
            (phone10, kind, admission_id, publication_id, revision, text, version, read_version, updated_at)
            VALUES (${phone10}, ${kind}, ${admissionId}, ${publicationId}, ${revisionParam},
                    ${text}, ${version}, ${readVersion}, ${timeParam})`;

          if (text.trim()) {
            await tx`UPSERT INTO parent_report_history
              (phone10, kind, report_date, admission_id, publication_id, revision, text, captured_at)
              VALUES (${phone10}, ${kind}, ${reportDate}, ${admissionId},
                      ${publicationId}, ${revisionParam}, ${text}, ${timeParam})`;
          }
          if (!unchanged && text.trim() && kind !== 'psychology') {
            const eventId = 'report_' + sha(publicationId + ':' + phone10);
            const notificationJson = JSON.stringify({
              title: 'Медси Бот',
              body: kind === 'morning' ? 'Опубликован утренний отчёт.' : 'Опубликован вечерний отчёт.',
              type: 'report', kind
            });
            await tx`UPSERT INTO push_outbox
              (event_id, role, phone10, notification_json, status, attempts, next_attempt_at, created_at)
              VALUES (${eventId}, ${'parent'}, ${phone10}, ${notificationJson},
                      ${'pending'}, ${zeroParam}, ${timeParam}, ${timeParam})`;
            notifications.push(phone10);
          }
        }

        await tx`UPSERT INTO report_submissions
          (submission_id, kind, payload_hash, publication_id, submitted_at, revision)
          VALUES (${submissionId}, ${kind}, ${payloadHash}, ${publicationId},
                  ${timeParam}, ${revisionParam})`;
        await tx`UPSERT INTO report_publication_head
          (kind, publication_id, revision, submitted_at)
          VALUES (${kind}, ${publicationId}, ${revisionParam}, ${timeParam})`;

        return {
          status: 'published', submissionId, publicationId, revision,
          recipients: recipients.length, notificationsQueued: notifications.length
        };
      });
    }
  };
}
