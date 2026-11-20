# Phase 1 UI checkpoint — locally verified, not approved or released

**Phase 1 remains in progress.** The Habit Details screen and interactive Today cards are implemented and pass the local checks below. This is not approval to release, deploy, push, start Phase 2, or treat the simulated workspace as production-ready. Changes are uncommitted on `bloom/phase-1-app`; no hosted database, Production configuration, or deployed Preview was changed for this correction.

The older Vercel Preview is still the earlier checkpoint at commit `35aa86b63051dc2ccd7284a471763d59c82e635f`; it does **not** contain these local changes and is not evidence for this implementation. Its authenticated rendering was previously blocked by Vercel SSO. Independent review of the current UI is still required before any phase decision.

## Changes in this checkpoint

- `components/sessions/sessions-workspace.tsx`
  - Added a dedicated, deep-linkable `HabitDetailsScreen`. It presents the habit name and description, current Lagos-week goal and progress, completed-session count, distinct completed Lagos days, measured/estimated/unknown time, and dated session history with recorded durations and notes.
  - Added Start Timer, Quick Log, Edit, and Archive actions, with confirmation where needed. An active session is passed into the existing `ActiveSessionTimer`; Details does not own another timer, clock, or session state. The same timer controls remain available while Details is open.
  - Made Today habit cards navigate through a stretched semantic link. Nested actions remain separate buttons. Back navigation restores the originating workspace and scroll position; the decorative back arrow is hidden from the accessible name.
- `app/globals.css` — added card-link focus/hover behavior, timer-in-card styling, responsive details layout, dark/system theme styling, and a reduced-motion rule.
- `tests/phase1-demo.browser.mjs` — expanded browser coverage for Details, metrics and goal progress, timer lifecycle, pause exclusion, Lagos midnight, full browser-process close/reopen, Quick Log during a timer, and the four-hour warning.
- `tests/phase1-navigation.browser.mjs` — expanded card, nested-action, history/back, keyboard focus, cross-tab, timer-blocking, reduced-motion, and axe coverage.
- `tests/session-ui.mock.mjs` — updated archive labels and makes the intercepted completion response deliberately differ from the extrapolated timer display, checking which value the history UI uses.
- `tests/session-core.test.mjs` — asserts display interpolation does not mutate the session’s persisted duration.

## Shared timer and analytics evidence

The workspace derives its active session from the loaded `data.sessions` and its elapsed display from `timerDisplayMs(active, data.segments, now)`. The Today card, non-Today panel, and Habit Details all receive that same session, segments, elapsed value, and command handlers. `ActiveSessionTimer` owns no clock or timer state. Pause, resume, complete, and cancel continue through the existing command path. This establishes shared **client UI state**, not backend authority or production reliability.

The executed synthetic browser scenarios verified:

- One visible timer across Today, Progress, and Details; monotonic display while navigating; running and paused state through refresh; blocking another timer in both running and paused states; and cross-tab visibility in the browser-local simulation.
- Persistence through a real Chromium process close/reopen using the same temporary browser profile, with one timer and no duplicate start.
- Quick Log from Today and from Details while another timer is running; the timer remains running. Existing pause/resume/complete/cancel controls remain reachable. Cancellation is excluded from completed analytics.
- A 60-second paused interval is excluded: a fake-clock run has 10 seconds active, 60 seconds paused, then 5 seconds active, displaying 15 seconds total. The completion at `2026-11-22T23:00:45Z` is attributed to Lagos Monday `2026-11-23`; the same scenario shows a 1/1 weekly target, one completed session, one active day, and 15 seconds measured in Details.
- The four-hour warning does not stop the session; it remains running until an explicit action. Multiple logs, cancelled-session exclusion, distinct-day counts, unresolved-goal behavior, measured/estimated/unknown totals, dates, and history are checked.
- The pure-core test leaves `duration_ms` null after display interpolation. In the intercepted PostgREST browser test, the displayed timer exceeds four hours but the mock returns a committed duration of 123,000 ms; history renders `0:02:03 measured`. This verifies client presentation behavior against a synthetic response only; it does not prove a real backend's authority.

## Verification performed and results

Repository-local checks, after the final test edits:

```text
npm run typecheck                                              PASS
npm run lint                                                   PASS
npx -y node@22 --experimental-strip-types --test tests/*.test.mjs  PASS — 11 tests, 0 failures
git diff --check                                               PASS
```

A production build of the UI source passed in the sanitized `/home/user/bloom-phase1-final-review` copy (no `.env*`, `.git`, or prior generated build state):

```text
LD_LIBRARY_PATH=/home/user/bloom-browser-libs/root/usr/lib/x86_64-linux-gnu npx -y node@22 node_modules/next/dist/bin/next build
```

Next.js 16.4.6 compiled, typechecked, generated static pages, and finalized route output successfully. This build included the final UI component/CSS. A separate build with synthetic loopback variables was used only for the intercepted browser harness below; `app/bloom-harness/page.tsx` exists only in that disposable copy and is not a product change. A later repeat build in a second clean copy was killed by the runner during initial optimized compilation without a compiler diagnostic; no source error was reported. Typecheck and lint also exceeded their first 180-second timeouts when launched in parallel with the development preview; after stopping that process, sequential reruns passed (4.4 seconds and 7.2 seconds). The earlier successful build and browser runs cover the same functional UI; the only later UI-source delta was singular/plural goal-label wording, which passed the final typecheck/lint and current-source smoke. The isolated live development preview also passed browser smokes for `/dashboard`, simulated habit creation, and the Lagos-midnight goal scenario: 1/1 progress, 15 seconds measured, one active day, and 60 seconds paused excluded.

Browser commands were run against that disposable copy, not a hosted service:

```text
BLOOM_PHASE1_DEMO=1 npx -y node@22 node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3103
LD_LIBRARY_PATH=/home/user/bloom-browser-libs/root/usr/lib/x86_64-linux-gnu npx -y node@22 tests/phase1-demo.browser.mjs
LD_LIBRARY_PATH=/home/user/bloom-browser-libs/root/usr/lib/x86_64-linux-gnu npx -y node@22 tests/phase1-navigation.browser.mjs
```

Results:

- `phase1-demo.browser.mjs` **passed** at 390px/dark and 1440px/light, plus edge cases, persistent-profile close/reopen, and fake-clock Lagos-midnight/goal checks. It reported no external browser requests or page errors; axe detected no violations on the scanned states. After the final singular/plural copy polish, the current-source preview reran the goal/pause/Details scenario successfully; the full suite was not repeated for that wording-only change.
- `phase1-navigation.browser.mjs` **passed** at 390px/dark and 1440px/light, including deep links, card-surface navigation, independently usable nested actions, scroll restoration, keyboard focus moving to the Details heading, cross-tab updates, active/paused second-timer blocking, and reduced motion. The timer pulse computed to `none` in Today and Details for a reduced-motion context. Axe detected no violations on the scanned views/forms.

The intercepted-only session/auth harness was built and served from the disposable copy with `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` and `NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-test-only`; Playwright intercepted those loopback requests. Reproduction commands (only in the disposable copy):

```text
mkdir -p app/bloom-harness
cp tests/fixtures/bloom-harness-page.tsx.fixture app/bloom-harness/page.tsx
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-test-only LD_LIBRARY_PATH=/home/user/bloom-browser-libs/root/usr/lib/x86_64-linux-gnu npx -y node@22 node_modules/next/dist/bin/next build
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=synthetic-test-only npx -y node@22 node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3100
LD_LIBRARY_PATH=/home/user/bloom-browser-libs/root/usr/lib/x86_64-linux-gnu npx -y node@22 tests/session-ui.mock.mjs
LD_LIBRARY_PATH=/home/user/bloom-browser-libs/root/usr/lib/x86_64-linux-gnu npx -y node@22 tests/phase1-auth.mock.mjs
```

`tests/session-ui.mock.mjs` **passed** (including intentionally simulated HTTP 400 maintenance and HTTP 503 lost-response cases), and `tests/phase1-auth.mock.mjs` **passed**. These are UI simulations, not real Supabase Auth, PostgREST, or PostgreSQL tests.

During verification, stale test labels/selectors for the old expandable details screen and old archive buttons were updated. The back arrow was marked decorative after its accessible name caused an exact-selector mismatch. A history selector was narrowed when the same habit description appeared in both Details and settings history. The final browser suites passed after those fixes.

## Reproduction and safety boundary

Use a disposable copy that excludes all `.env*` files, `.git`, `.next`, and generated state. The synthetic dashboard requires explicit `BLOOM_PHASE1_DEMO=1`; it stores data and timestamps in the browser only and does not sync or call Supabase. The test-only PostgREST harness fixture must never be added to the shipped application. Do not substitute hosted URLs, credentials, real user data, or Production settings.

An isolated Arena sandbox Live Preview is running from `/home/user/bloom-phase1-preview-review` on port 3104. It is a clean copy with no `.env*` files, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, or `VERCEL_ENV`; only `BLOOM_PHASE1_DEMO=1` is set. The dashboard and simulated habit creation passed a local browser smoke test. This is not a Vercel/hosted deployment, and browser data stays in that preview's local storage.

## Still unverified / approval gates

- **No backend or production evidence:** no real Supabase session integration, authorization/RLS proof, durable server timer recovery, actual-commit goal scheduling, multi-device/concurrent-write safety, security, or production persistence was exercised. Browser-local simulation uses its own clock and local storage. The mocked response-duration check tests only client behavior.
- The ordinary `/dashboard` without the explicit simulation flag remains the existing authenticated legacy dashboard. This correction does not switch real users to the new session model or provide a release-ready integrated app.
- Account deletion remains unavailable; full reauthentication, Storage cleanup, FK/race/stale-token and atomic-failure coverage remain unresolved. Comprehensive freeze/recovery, backup, backfill and rollback/forward-recovery gates remain as previously documented.
- Axe and keyboard checks are useful but limited; they are not a full manual screen-reader, accessibility, device, or visual acceptance review. The current deployed Preview is stale.

**Review status:** ready for independent review of the exact local UI in an isolated, non-production preview; not independently approved. The current uncommitted correction has not been pushed or deployed. Await the user's review/approval before Phase 2 or any release action.
