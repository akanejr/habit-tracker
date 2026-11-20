# Bloom local delivery status — work in progress

This branch is NOT a release and is not ready for final independent review. Do not run migrations or release it on a hosted project. This document is a progress record, not a complete implementation plan or production runbook.

## Previous foundation checkpoint

For the subsequent local database and UI milestone, see `docs/bloom-local-testing.md`. The statements below describe the earlier checkpoint, not the current branch.

## Implemented foundation

`lib/sessions/core.ts` provides pure display/reporting calculations for a proposed session representation: Lagos-week goal selection, weekly session counts and separate active-day counts, measured versus estimated duration totals, unknown durations, distinct-habit daily progress, and timer-display interpolation. A timer display is not authoritative and must never be used to calculate persisted completion duration. Its data shape is provisional and is not connected to the dashboard or a database API. An unresolved goal schedule produces an error instead of silently choosing a potentially incorrect historical goal.

`tests/session-core.test.mjs` uses Node 22's experimental TypeScript stripping and the built-in test runner. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`. These do not connect to Supabase. Next.js loads environment files automatically; use an isolated source copy without any `.env*` files for a build when existing local environment files must not be read.

## Blocking correctness and security work

- A change scheduled based on its **actual transaction commit time** can cross the Lagos Monday boundary after an in-transaction clock sample. A deferred trigger still runs before commit. PostgreSQL commit timestamps are not permanently retained. The previous local draft in `/home/user/Bloom-final-spec-work/proposed_migration.sql` relies on that temporary metadata and is **not deployable**. We have not implemented or verified a durable commit-time capture design, its crash/restart behavior, its backlog retention, or the actual boundary race. Do not substitute client time, transaction start time, or pre-commit trigger time.
- No production-ready session schema, migration, write fence, database commands, RLS policy changes, or API client have been added on this branch. Legacy daily check-off remains in the application. The pure helpers are not user-facing functionality.
- Secure self-service account deletion is not implemented. A safe design must fence writes and access for stale JWTs, address concurrent requests and all related records and storage, authenticate/authorize deletion, perform privileged operations on a trusted backend without placing a service-role credential in app code, and handle failure and retries. Manual console deletion is not a replacement.
- Existing habits, logs, versions, settings and history must remain preserved. Freeze all old and new writers persistently; prove backup, backfill, authenticated testing and pre-write rollback; design and test lossless forward recovery after new session writes. These remain incomplete. Previous isolated candidate tests do not establish this branch's production safety.
- Timer/Quick Log, responsive Today, creation/edit/history, goals, Progress, theme/settings and account controls are not implemented against the new session model. Offline, errors and accessibility are incomplete. Database/Auth/RLS/concurrency, responsive, security, end-to-end and release testing remain outstanding.

## Local evidence

Run and results in the delivery report apply to pure unit tests and the current legacy application's build only. Passing them cannot verify a user-visible session workflow or database security. The build was run in a separate copy without environment files; no hosted database or deployment was accessed. Prior candidate evidence and limitations remain in `/home/user/Bloom-final-spec-work/README.md` and are not evidence that this branch is safe to deploy.

## Release boundaries

Hosted inspection, hosted SQL/settings/data, Preview database writes, deployment and release each require separate explicit authorization. Do not merge unfinished work into main or connect an isolated local stack to a hosted project. Never commit secrets or use a service-role key in the browser or app. Independent review can only be requested after implementation, appropriate local integration/security/recovery tests and the outstanding correctness problems are resolved.
