# Habit Tracker

A habit-tracking web app built with **Next.js 16 (App Router) + TypeScript**,
backed by a hosted **Supabase** project (Postgres, Auth, REST).

> **Status:** project foundation only. Architecture, authentication plumbing,
> and the database schema are in place. The habit-tracking interface is not
> built yet — see [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and
> roadmap.

## Tech stack

| Layer        | Technology                                              |
| ------------ | ------------------------------------------------------- |
| Framework    | Next.js 16 (App Router), React 19, TypeScript           |
| Backend      | Supabase (Postgres 17, GoTrue Auth, PostgREST)          |
| Hosting      | Vercel (primary target)                                 |
| Supabase     | Project `Habit-Tracker` (`retkelaxegvlkuzhgosz`, eu-west-1) |

## Quick start (local)

Prerequisite: Node.js 22 (see `.nvmrc`).

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase keys
npm run dev                  # http://localhost:3000
```

The home page shows a live Supabase connection check — green means the app
can reach the hosted project and the schema is applied.

## Environment variables

| Variable                      | Required | Where it goes | Notes                                                        |
| ----------------------------- | -------- | ------------- | ------------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`    | Yes      | `.env.local` + Vercel | Project URL. Not secret.                            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes    | `.env.local` + Vercel | Publishable/anon key. Safe in browser; RLS enforces access. |

Get the project URL and publishable (or legacy anon) key from **Supabase Dashboard → Project Settings → API**. The `NEXT_PUBLIC_` values are intentionally public and embedded in browser code at build time; add them to Vercel before the build and redeploy after changing them. Do not use a service-role or secret key for either variable.

Security rules:

- `.env.local` is gitignored — real values are never committed.
- Only `NEXT_PUBLIC_*` variables (the URL and publishable key) are ever sent
  to the browser. No service-role key is used or required.
- All data access goes through Row Level Security policies, so the anon key
  alone cannot read other users' data.

## Project structure

```
habit-tracker/
├── app/                        # Next.js App Router pages & routes
│   ├── layout.tsx              # Root layout + metadata
│   ├── page.tsx                # Foundation status page (connection check)
│   ├── globals.css             # Global styles (no external assets)
│   ├── icon.svg                # App icon
│   └── auth/
│       ├── callback/route.ts   # Exchanges auth codes for sessions
│       └── auth-error/page.tsx # Auth failure placeholder
├── lib/
│   ├── env.ts                  # Typed env access + "configured?" check
│   └── supabase/
│       ├── client.ts           # Browser client (Client Components)
│       ├── server.ts           # Server client (Server Components/Actions)
│       └── middleware.ts       # Session refresh logic
├── types/
│   └── database.ts             # Database types (match the SQL schema)
├── supabase/
│   └── migrations/             # SQL migrations (source of truth)
├── proxy.ts                    # Runs session refresh on every request
├── vercel.json                 # Vercel project config
├── .env.example                # Documented env template (safe to commit)
└── ARCHITECTURE.md             # System design & roadmap
```

## Database

The initial schema (`supabase/migrations/20261117120210_initial_schema.sql`)
creates `profiles`, `habits`, and `habit_logs` with Row Level Security
policies so every user can only access their own rows, plus a trigger that
auto-creates a profile on sign-up.

Both the initial schema and `20261117133259_gate_2_privilege_hardening.sql` are already applied to the connected hosted project and recorded in its migration history. The latter is included here to keep the repository aligned; copying or committing it does not execute it. When using the Supabase CLI, review the target project and migration history before running any database commands. For a separately authorized target (install and configure the CLI first):

```bash
supabase link --project-ref <target-project-ref>
supabase db push
```

## Deploying to Vercel

1. Push this repo to GitHub.
2. In Vercel: **Add New → Project → Import** the GitHub repo.
   - Framework preset: **Next.js** (auto-detected; `vercel.json` confirms it).
   - Root directory: `./` (repo root).
   - Node.js: **22.x** (also declared in `package.json` and `.nvmrc`).
   - Build command: `npm run build` (default); keep the default output settings.
3. Add the environment variables from the table above in
   **Settings → Environment Variables** (Production + Preview).
4. Deploy.

### After the first deploy — Supabase auth URLs

The configured **Site URL** is the fallback for Supabase auth redirects. Update it in **Supabase Dashboard → Authentication → URL
Configuration**:

- **Site URL:** your Vercel URL (e.g. `https://habit-tracker.vercel.app`)
- **Redirect URLs:** add `https://<your-domain>/auth/callback` and keep
  `http://localhost:3000/auth/callback` for local development.

## Scripts

| Command            | Purpose                              |
| ------------------ | ------------------------------------ |
| `npm run dev`      | Start dev server on `0.0.0.0:3000`   |
| `npm run build`    | Production build                     |
| `npm run start`    | Run the production build locally     |
| `npm run lint`     | ESLint                               |
| `npm run typecheck`| TypeScript check without emitting    |

## Roadmap

1. Sign-in / sign-up UI (email + password).
2. Habit CRUD (create, edit, archive habits).
3. Daily check-in (mark habits complete, streaks).
4. Statistics and polish.

**Testing limits:** The hosted database connection is checked via a public, RLS-protected read. Authentication UI and end-to-end sign-up, sign-in, email confirmation, and authenticated CRUD testing are still pending. For PKCE email links, configure Supabase email templates and redirect URLs to use the callback when the sign-in flow is implemented; confirmation behavior depends on the chosen flow and browser. Vercel preview URLs must also be added to the Supabase redirect allow list when auth is tested there.
