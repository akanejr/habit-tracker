# Phase 1 UI checkpoint — not a release

**Phase 1 remains in progress.** The session workspace now occupies the normal `/dashboard` route in an explicitly enabled synthetic mode. Without that mode the existing authenticated legacy dashboard is preserved. This protects existing users but also means the default dashboard is still the legacy day-log experience: a real integrated session backend is not established. The mock is not production-ready and no release or review is requested by this checkpoint.

## Dashboard and safety boundary

- In an isolated local environment, set `BLOOM_PHASE1_DEMO=1` to use `/dashboard` with browser-local synthetic data. The landing page offers a clearly labelled simulation link. `/bloom-phase1` is only a redirect to `/dashboard` when simulation is enabled; it is not a second workspace.
- Simulation is refused if `VERCEL_ENV=production` or if `NEXT_PUBLIC_SUPABASE_URL` is configured to anything other than a literal loopback host. When the flag is absent, the existing authenticated dashboard remains unchanged. Neither the demo adapter nor its dashboard proxy calls Supabase. Do not set the flag or change hosted environment configuration without separate permission.
- A persistent banner explains that habits, timestamps and simulated goal weeks are stored locally, not on a server, and are not synced or production-ready. Simulated timestamps and goal effective weeks use the browser clock; they do not implement or prove the actual-commit rule, cross-device concurrency, database authority or recovery. Never use real data in this demo.
- Today, Progress and Settings share one workspace and URL navigation. Deep links and browser back/forward preserve view and habit details. The interface confirms before discarding changed forms and retains an open Quick Log when an unrelated timer operation succeeds. Draft forms are reset when switching habits; fields are disabled while a command is pending. The screen explicitly describes offline pause behavior, separates measured/estimated/unknown durations, keeps counts when a goal is unresolved, and leaves account deletion unavailable.
- Habit management, session/timer and goal interfaces use the same synthetic adapter and state; no experimental SQL was promoted into migrations. Authentication screens remain the existing implementation and were tested only with mocked responses. The older `/bloom-local` route is a separately fenced local database test path, not a production bridge.

## Local verification performed

The final source was copied without `.env*`, and the tests below used synthetic identities and endpoints only:

- Node 22: typecheck, lint, 11 unit tests and a production build passed. A stale generated type referencing a discarded test fixture caused one initial typecheck failure in the disposable copy; clearing that copy's generated `.next` directory and rerunning passed. No repository or production files were removed.
- `phase1-demo.browser.mjs` passed in Chromium at 390px/dark and 1440px/light: landing-to-dashboard navigation, habit and session journeys, timer recovery, backdated Quick Log, target/no target, offline handling, profiles/themes, reporting and per-view state. It checked simulated five-hour warning, multiple logs, cancellation and unresolved goal counts. There were no non-local browser requests in those journeys.
- `phase1-navigation.browser.mjs` passed at both viewports: draft-discard confirmation, browser back, one active timer in the mock, switching forms between habits without carrying inputs, deep links, missing details and automated axe scans on creation, Quick Log, goal, details, Progress and Settings views. A separate keyboard-focus and two-tab refresh scenario passed in the browser-local simulation; it does not prove concurrent-write safety. These scans do not constitute a full accessibility audit.
- `session-ui.mock.mjs` passed against intercepted synthetic PostgREST responses, including maintenance, retry, input locking during an uncertain response, an intentionally dropped response and the older local adapter. `phase1-auth.mock.mjs` passed synthetic auth UI cases. These do not test real Supabase authorization or real network behavior.
- The disabled alias returned 404 and signed-out dashboard redirected in the default local configuration. A synthetic hosted URL and a synthetic production environment each refused simulation; the enabled legacy alias redirected to `/dashboard`. No actual hosted project was queried.

## Reproduction

Use a disposable source copy excluding `.env*`, `.git` and `.next`, with Node 22 and the existing dependencies. Build, then start with `BLOOM_PHASE1_DEMO=1` on port 3103. Run `tests/phase1-demo.browser.mjs` and `tests/phase1-navigation.browser.mjs`. For intercepted Auth and session tests, copy the harness fixture to `app/bloom-harness/page.tsx` only in the disposable copy, build/start on port 3100 with `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` and a synthetic anon value, and run `tests/session-ui.mock.mjs` and `tests/phase1-auth.mock.mjs`. Their loopback requests are intercepted by Playwright. Do not substitute a hosted URL or credentials, and never ship the harness fixture. Chromium and its OS libraries are required.

## Still unverified or blocked

Real database/session integration, actual-commit goal scheduling, production authentication/security, real multi-device and phone-lock timer recovery, Storage/deletion, full accessibility and deployment/recovery readiness remain future-phase work. The default dashboard has not been switched to the new session data model because no approved backend exists. Simulated UI tests do not change these limitations. Shared Preview/Production database restrictions and phase approval gates remain in force.
