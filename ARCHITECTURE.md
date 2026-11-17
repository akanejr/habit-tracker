# Architecture

## System overview

```
┌─────────────┐        HTTPS         ┌──────────────────────────────────┐
│   Browser   │ ───────────────────▶ │  Vercel (Next.js 16)             │
│             │                      │                                  │
│             │ ◀─────────────────── │  • App Router pages & routes     │
└──────┬──────┘   cookies + HTML     │  • proxy.ts (session refresh)    │
       │                            │  • /auth/callback (code exchange)│
       │                            └───────────────┬──────────────────┘
       │                                            │  @supabase/ssr
       │                                            │  (anon key + session JWT)
       │                                            ▼
       │                            ┌──────────────────────────────────┐
       └───────────────────────────▶│  Supabase (hosted, eu-west-1)    │
          direct API calls          │  • GoTrue Auth (email/password)  │
          (browser client)          │  • Postgres 17 + PostgREST       │
                                    │  • Row Level Security            │
                                    └──────────────────────────────────┘
```

The app has **no Arena-specific production dependency**. `allowedDevOrigins` permits development assets in the Arena preview; it is a Next.js development-only setting. The application otherwise runs normally on Node and Vercel.

## Request flow

1. **Page and route requests** (excluding static assets) pass through `proxy.ts`, which calls
   `updateSession()` to refresh the Supabase session cookie if it expired.
   `supabase.auth.getUser()` validates the token against the Auth server —
   the app never trusts unverified session data for authorization.
2. **Server Components** use the server client (`lib/supabase/server.ts`),
   which reads/writes the session via cookies.
3. **Client Components** use the browser client (`lib/supabase/client.ts`),
   which talks directly to the hosted Supabase REST/Auth APIs.
4. **PKCE callback:** `/auth/callback` exchanges an authorization code for a session and redirects to a validated same-origin path. This is plumbing, not a complete sign-in flow. The future auth implementation must configure redirect URLs and, for email flows, templates appropriately and test each flow end to end.

## Data model

```
auth.users ──1:1──▶ profiles        (id = auth user id)
   │                  display_name, avatar_url
   │
   └──1:N──▶ habits                 (user_id)
              name, frequency (daily|weekly|custom),
              target_per_week, color, icon, is_active
                 │
                 └──1:N──▶ habit_logs   (habit_id, user_id)
                            completed_on (date), note
                            UNIQUE (habit_id, completed_on)
```

- `profiles` is auto-created by a database trigger when a user signs up.
- `habit_logs` enforces one completion per habit per day at the database
  level, which makes streak calculation straightforward.
- `updated_at` columns are maintained by triggers.

## Security model

- **Row Level Security is enabled on every table.** Policies restrict each
  user to their own rows (`auth.uid() = user_id`), so the publishable/anon
  key is safe to ship in the browser bundle.
- **The service-role key is never used by the app** in the foundation. No service role key is configured. If a future administrative job needs one, it must stay server-only and out of git.
- **Secrets live in environment variables only**: `.env.local` locally
  (gitignored), Vercel Environment Variables in production. `.env.example`
  documents every variable with placeholders — it is the only env file
  committed.
- **No local emulator.** The app talks to the hosted Supabase project in
  every environment, so what you test is what ships.

## Environment strategy

| Environment | Env vars come from              | Supabase target        |
| ----------- | ------------------------------- | ---------------------- |
| Local dev   | `.env.local` (gitignored)       | Hosted project         |
| Preview     | Vercel Preview env vars         | Hosted project         |
| Production  | Vercel Production env vars      | Hosted project         |

`NEXT_PUBLIC_*` values are inlined at **build time**, so on Vercel they must
be set before the build runs (the dashboard handles this automatically when
variables are added to the project).

The app is designed to boot even when env vars are missing: `lib/env.ts`
exposes `isSupabaseConfigured`, the proxy passes requests through untouched,
and the home page renders setup instructions instead of crashing.

## Deployment

- **Target:** Vercel, importing the GitHub repo root.
- **Build:** `npm run build` → `.next` output (Next.js defaults).
- **Node:** 22 (pinned in `.nvmrc`).
- **Post-deploy step:** set the Supabase Site URL and redirect allow list to
  the Vercel domain (see README).

## Folder structure rationale

- `app/` — routes only; no business logic in pages.
- `lib/supabase/` — the three canonical Supabase client entry points
  (browser, server, proxy), so there is exactly one place to change how
  sessions are handled.
- `lib/env.ts` — single source of truth for environment variables.
- `types/database.ts` — typed Supabase client; regenerate from the schema
  with the Supabase CLI once the schema stabilises.
- `supabase/migrations/` — SQL is the source of truth for the database,
  versioned alongside the app code.
- Shared components can be added when the interface is built.

## Roadmap

1. **Auth UI** — sign-in/sign-up forms, session-aware navigation.
2. **Habits CRUD** — create, edit, archive; list with daily/weekly targets.
3. **Check-in** — toggle today's completions, streak calculation.
4. **Stats & polish** — weekly views, reminders, PWA installability.
