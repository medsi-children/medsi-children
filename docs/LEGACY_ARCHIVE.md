# Legacy Google / Cloudflare source archival

The production application is located in `medsi-bot-main`. Historical Apps Script and Cloudflare implementation files (including the exact two last Worker builds) have been preserved in the existing read-only-in-practice branch `archive/timeweb-next-2026-11-05` at commit `11f2f8c137a03916778a93a9d09444c2cdde8998`.

This active branch no longer contains `apps-script/medsi-bot` or `services/cloudflare`. Original deployment scripts and legacy-only regression tests were archived too. Modern application tests use the bundled report algorithms under `services/postgres-next/legacy-report-source`.

**Important:** This is Git repository housekeeping only. Actual Google Sheets, Apps Script deployments, Cloudflare Workers, KV, D1, and old Timeweb resources were not disabled, migrated, or deleted. The operator intends to keep these resources for at least 1–2 months to observe post-cutover stability. Do not delete them without a separate task.

Use `npm run verify` and `npm run verify:postgres-next` before releases. Never add patient records or credentials to Git history.
