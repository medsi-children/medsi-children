const KINDS = ['morning', 'evening', 'psychology'];
const PHONE_RE = /^\d{10}$/;
const blankReports = () => ({ morning:'', evening:'', psychology:'' });

export function assembleEducatorReports({ profiles, children, admissions, current, heads, rawByPublication }) {
  if (![profiles, children, admissions, current, heads].every(Array.isArray)) {
    throw new Error('Incomplete educator dashboard snapshot.');
  }
  if (profiles.length > 300 || current.length > 2000 || children.length > 300) {
    throw new Error('Unexpectedly large educator roster.');
  }
  const active = new Set(admissions.filter(row => row.status === 'active').map(row => row.admission_id));
  const childMap = new Map(children.map(c => [c.child_id, c]));
  const currentByPhone = new Map();
  for (const report of current) {
    if (!PHONE_RE.test(String(report.phone10 || '')) || !KINDS.includes(report.kind)) continue;
    const existing = currentByPhone.get(report.phone10) || blankReports();
    existing[report.kind] = String(report.text || '');
    currentByPhone.set(report.phone10, existing);
  }
  const childCards = new Map();
  for (const profile of profiles) {
    if (!PHONE_RE.test(String(profile.phone10 || '')) || !active.has(profile.admission_id)) continue;
    const child = childMap.get(profile.child_id);
    if (!child) throw new Error('Active parent references a missing child.');
    const id = String(profile.admission_id);
    if (!childCards.has(id)) {
      childCards.set(id, {
        childId: String(child.child_id), admissionId: id,
        childName: String(child.registered_first_name || ''),
        surname: String(child.surname || ''),
        parents: [], parentViews: []
      });
    }
    const card = childCards.get(id);
    if (card.childId !== String(child.child_id)) throw new Error('Admission identity conflict.');
    const parent = {
      parentName: String(profile.parent_name || ''),
      relationship: String(profile.relationship || 'Родитель'),
      phone: '8' + profile.phone10
    };
    card.parents.push(parent);
    card.parentViews.push({
      phone: parent.phone, parentName: parent.parentName,
      reports: currentByPhone.get(profile.phone10) || blankReports()
    });
  }

  const raw = {};
  for (const kind of KINDS) {
    const head = heads.find(row => row.kind === kind);
    const publication = head && rawByPublication.get(head.publication_id);
    if (publication && publication.kind !== kind) {
      throw new Error('Raw report publication kind mismatch.');
    }
    raw[kind] = publication
      ? { reportDate: String(publication.report_date || ''),
          normalizedText: String(publication.normalized_text || ''),
          rawText: String(publication.raw_text || ''),
          publicationId: head.publication_id }
      : { reportDate: '', normalizedText: '', rawText: '' };
  }
  return {
    ok: true,
    raw,
    children: [...childCards.values()]
      .map(c => ({
        ...c,
        parents: c.parents.sort((a,b)=>a.phone.localeCompare(b.phone)),
        parentViews: c.parentViews.sort((a,b)=>a.phone.localeCompare(b.phone))
      }))
      .sort((a,b)=>(a.surname + a.childName).localeCompare(b.surname + b.childName,'ru'))
  };
}

// SECURITY: all reading and clinical data association occurs only inside
// the service. Any HTTP endpoint must authenticate educator role BEFORE calling it.
export function createEducatorReportsDashboardStore(sql) {
  if (!sql || typeof sql.begin !== 'function') throw new Error('YDB query client required.');
  return {
    async readForEducator() {
      return sql.begin({ isolation: 'snapshotReadOnly', idempotent: true }, async tx => {
        const [profiles, children, admissions, current, heads] = await Promise.all([
          tx`SELECT phone10, parent_name, relationship, child_id, admission_id FROM parent_profiles`,
          tx`SELECT child_id, registered_first_name, surname FROM children`,
          tx`SELECT admission_id, status FROM admissions`,
          tx`SELECT phone10, kind, text FROM parent_current_reports`,
          tx`SELECT kind, publication_id FROM report_publication_head`
        ]);
        const rawByPublication = new Map();
        for (const head of heads) {
          if (!KINDS.includes(head.kind) || !head.publication_id) continue;
          const [publication] = await tx`
            SELECT publication_id, kind, report_date, raw_text, normalized_text
            FROM raw_reports WHERE publication_id = ${head.publication_id}`;
          if (publication) rawByPublication.set(head.publication_id, publication);
        }
        return assembleEducatorReports({ profiles, children, admissions, current, heads, rawByPublication });
      });
    }
  };
}

// Explicit role gate that is easy to exercise in tests. verifyEducator must
// reject a missing/invalid/expired educator session, including parent preview.
export function educatorReportDashboardHandler({ verifyEducator, dashboardStore }) {
  if (typeof verifyEducator !== 'function' || !dashboardStore?.readForEducator) {
    throw new Error('Protected dashboard requires an educator auth verifier.');
  }
  return async function handle(req, res) {
    try {
      if (req.method !== 'GET') return res.status(405).json({ok:false,message:'Method not allowed.'});
      const session = await verifyEducator(req);
      if (!session || session.role !== 'educator') {
        return res.status(403).json({ok:false,message:'Недостаточно прав.'});
      }
      res.setHeader('cache-control','no-store');
      const dashboard = await dashboardStore.readForEducator();
      return res.status(200).json(dashboard);
    } catch (_) {
      return res.status(503).json({ok:false,message:'Не удалось загрузить отчёты.'});
    }
  };
}
