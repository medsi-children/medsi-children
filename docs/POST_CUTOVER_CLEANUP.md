# Post-cutover cleanup gate — Медси Бот 2.0
Updated: 2026-11-05. Source of truth: `medsi-bot-main`, deployment App Platform 2.0.

## Critical STOP: import delta from pre-cutover snapshot
Initial snapshot reportedly covered D1 to about **17:50 Moscow** and Apps Script to about **17:43 Moscow**, 2026-11-05. It is **not independently verified** that all later changes were reconciled. Until backed-up and reconciled, **DO NOT** delete, disable, or mutate the original Cloudflare D1/KV, Apps Script, Google Sheet, media storage, their access credentials, the old App Platform or old production refs needed for forensic reconciliation.

- Verify that 2.0 is writing to PostgreSQL only; identify post-snapshot D1/Google changes and conflict with PostgreSQL records (do not blindly overwrite later PostgreSQL changes).
- For each origin, classify lost/stale/deleted/duplicate items and replay with idempotent keys and current admission fencing; back up first; secure HMAC manifests and counts; request explicit approval before executing live migration.
- The old Workers were reportedly un-frozen after cutover. Check actual state; if still receiving writes, establish a single authoritative writer and coordinate with the live migration operator. Prevent double-push and double-report-distribution.
- Verify HTTPS for root AND www, saved iOS PWA origin and WebAuthn RP ID, and push delivery.
- Only after gap reconciled and recovery path verified can old deployment services and GitHub workflows be decommissioned.

## Actual dependency audit before deletion
`services/postgres-next/app/report-engine.mjs` previously read SIX algorithm modules from `apps-script/medsi-bot` at runtime; this branch bundles them under `services/postgres-next/legacy-report-source` with **identical Git blobs**, and switches the engine to local bundled files. This is intentional: no algorithm rewrite, output parity retained.

Other consumers that require remodeling before deleting legacy trees:
- `scripts/verify-source-control.mjs` still verifies Cloudflare Wrangler migrations and Apps Script allowlist; adapt to PostgreSQL.
- `scripts/sync-report-rules.mjs` still writes to Apps Script; remove/replace safely.
- Root `npm run verify` includes legacy Apps Script / Cloudflare tests. Keep them until their important safety assertions are covered in NEXT tests, then retire old fixtures.
- `.github/workflows/release-apps-script.yml`, `release-cloudflare-workers.yml`, `deploy-cloudflare.yml`, `audit-report-delivery.yml`, and `apply-report-history-0010.yml` still target legacy release paths/production. Disable only after reconciliation and operator confirmation.
- `.github/workflows/verify.yml` is general validation; keep. `verify-postgres-next.yml` tests PostgreSQL and must remain.
- Old `AGENTS.md`, system maps, docs and deployment scripts need updating to the Postgres source of truth.

## Planned removal once green checks and post-cutover audit are complete
1. Remove or hard-disable legacy publishing workflows from the default branch and ensure `timeweb-next` cannot automatically publish to Cloudflare/Apps Script after rollback handoff. Do not remove Timeweb App 2.0 deploy or PostgreSQL tests.
2. Migrate remaining useful regression tests away from the old runtime; all current behavior and security cases must be covered.
3. Remove `apps-script/medsi-bot` and `services/cloudflare` from active tree only after dependency scans and green CI; protect source reproducibility in version history, not the active runtime.
4. Archive/delete obsolete experimental refs (e.g. `feature/ydb-unified-cutover`, `feature/timeweb-s3-hybrid`) **only after checking open PRs, unique code, backup/recovery needs, and private/sensitive content**. Preserve exact SHAs externally in a restricted maintenance inventory.
5. Remove unused service credentials/triggers ONLY after live data reconciliation and backup verification. Never delete clinical data or storage as a side effect of Git cleanup.

## Privacy / history warning
The GitHub repository is currently **public**. Deleting a branch, file or tag does **not** guarantee removal of its content from Git history, forks, mirrors, caches or GitHub pull-request refs. Before deletion, inventory secrets, tokens, patient identifiers, exported captures and data dumps across reachable refs; if any real exposure is discovered, restrict access, rotate secrets and perform a planned history remediation with GitHub support. Do not copy sensitive matches into chat, issue bodies or logs.

## This cleanup branch
The old archive/ directory and legacy publishing workflow definitions are scheduled for removal from the default branch in this PR. Historical refs are not deleted, and legacy scripts and Workers remain until tests and reconciliation are complete.
No production behavior is changed until merged. Existing Apps Script and Cloudflare trees, legacy workflow definitions, production credentials, domain, database, actual data and old rollback refs remain untouched. This branch makes the report runtime independently portable and expands PostgreSQL validation to PRs, preparing a future safe removal.
