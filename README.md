# Bloom — Habit Tracker

A Next.js App Router and Supabase application for building small, sustainable habits. It includes email/password authentication and a Today dashboard with basic habit management. Progress and Settings are placeholders.

## Run locally

Use Node.js 22 (see `.nvmrc`).

```bash
npm install
cp .env.example .env.local
# Fill in the existing Supabase project's public URL and publishable key.
npm run dev
```

The app runs at `http://localhost:3000`. The project uses the hosted Supabase service, including in development; it does not require an emulator or Arena infrastructure.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Hosted Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase publishable/anon key |

Get the values from the existing Supabase project. These `NEXT_PUBLIC_` values are public and can be included in browser code. Set them in `.env.local` and in Vercel for each applicable environment **before building**; redeploy after changes. Never use a service-role or secret key here. `.env.local` and other real `.env*` files are Git-ignored; `.env.example` contains placeholders only.

## Authentication

- `/` welcomes visitors; `/signup`, `/login`, `/resend-confirmation`, `/forgot-password` and `/reset-password` provide email/password and verification flows.
- Signup supplies `display_name` as user metadata. The existing `handle_new_user` trigger creates the corresponding profile. Email confirmation is required by the current hosted Auth settings.
- `/auth/callback` exchanges Supabase's one-time PKCE code for a session. For PKCE, open the email link in the **same browser and device** that initiated the request. Links can expire or be used only once.
- `/dashboard` is the protected Today dashboard. A server-side Auth check protects it; signed-out visitors are sent to login. Logout ends the current session.
- Authenticated data access uses the existing Supabase client and Row Level Security. Existing table policies and privileges are unchanged.

### Auth URL and email setup

Before real email verification or password recovery, an authorized operator must review **Supabase Dashboard → Authentication → URL Configuration**. Set the Site URL to the intended canonical application URL and allow the exact callback URL(s), including:

- `https://habit-tracker-one-puce.vercel.app/auth/callback` (production confirmation)
- `https://habit-tracker-one-puce.vercel.app/auth/callback?next=/reset-password` (production recovery)
- `http://localhost:3000/auth/callback` and `http://localhost:3000/auth/callback?next=/reset-password` (local development, if used)
- The specific preview origin's corresponding callback URLs if testing there.

Supabase interprets `?` as a single-character wildcard in allow-list patterns; verify both actual callback URLs using its redirect URL tester. Only allow domains you control. These settings are not modified by the app.

The built-in Supabase email sender is intended for testing and, without custom SMTP, restricts recipients and has low rate limits. Configure production SMTP and review email delivery settings before onboarding users. Do not change Auth settings or templates without the project owner's approval.

## Today and habit management

Create, edit, archive, complete, or undo a completion without reloading. The dashboard uses `Africa/Lagos` for its date, and the week runs Monday through Sunday. Daily habits appear every day; weekly habits appear until their target is met, while a habit completed today remains visible for undo. A weekly target counts the habit's completions in the current week even if its current frequency or target was edited during that week. An empty day shows 0%, not a completed day. Preferred time is informational and does not send a reminder.

The UI prevents an extra completion when the weekly target has been reached, but that weekly limit is not enforced atomically by the database; simultaneous clients or direct API calls could exceed it. The existing unique constraint enforces at most one completion per habit and date. Archiving updates `is_active` and never deletes the habit or its logs. The approved history trigger stores metadata versions; it cannot reconstruct settings from before its baseline.

## Project structure

- `app/`: welcome, auth routes, PKCE callback and protected Today dashboard.
- `components/`: shared branding, auth UI, and habit management.
- `lib/habits/`: Lagos dates and daily/weekly progress calculations.
- `lib/supabase/`: browser/server clients and request-time session refresh.
- `proxy.ts`: session refresh entry point.
- `types/database.ts`: database types.
- `supabase/migrations/`: recorded schema and approved privilege-hardening SQL. These migrations are already applied to the existing hosted project; do not re-run them without reviewing the target and migration history.
- `ARCHITECTURE.md`: architecture and session/security notes.

## Checks and deployment

```bash
npm run typecheck
npm run lint
npm run build
```

Import the existing GitHub repository into Vercel, use the Next.js preset and Node.js 22, and configure the two public variables. Deployments require a separate commit/push and any requested approval. A successful build is not a substitute for testing the full email, sign-in, recovery, session-refresh and logout flows against hosted Supabase.
