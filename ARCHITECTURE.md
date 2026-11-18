# Architecture

## Overview

The Next.js 16 App Router application uses the existing hosted Supabase project for Auth and Postgres. It is deployable on Vercel and has no Arena-specific production dependency. The development-only preview origin in `next.config.ts` permits Arena's hosted development preview.

- `app/`: welcome, email/password forms, confirmation callback, and a minimal protected post-login landing. No habit-management interface is implemented yet.
- `components/auth/`: client-side forms and logout action.
- `lib/supabase/client.ts`: browser client for Supabase Auth using the publishable key.
- `lib/supabase/server.ts`: request-scoped server client for identity and RLS-protected queries.
- `proxy.ts` and `lib/supabase/middleware.ts`: refresh the session and propagate Supabase's cookies and cache headers. Responses passing through the proxy are marked private/no-store.
- `app/auth/callback/route.ts`: exchanges the one-time PKCE code and accepts only known local destinations. It propagates auth cookies and cache headers and prevents caching.

## Auth flow

1. Signup sends the full name as `display_name` in Supabase Auth user metadata. The existing `handle_new_user` trigger creates a profile with that name. With the project's confirmation setting enabled, a signup request does not mean the email is verified.
2. Supabase sends confirmation and recovery links. The browser requests the link with a callback URL, stores a PKCE verifier, and must open the resulting link in the same browser and device. The callback exchanges the code for session cookies.
3. Login uses `signInWithPassword`. The proxy refreshes the session; the protected `/dashboard` also validates identity with `getUser()` and queries only that user's RLS-protected profile. It never trusts an unverified `getSession()` user for authorization.
4. Recovery uses `resetPasswordForEmail`, the same callback, and `updateUser` after the recovery session is established. Logout signs out the local session. Expired or invalid links receive an error page.

Supabase SSR's browser client uses JavaScript-accessible cookies; this is not an HttpOnly-only/BFF session design. Secure production operation still depends on HTTPS, safe browser code, appropriate Supabase redirects, email delivery, cache behavior, and end-to-end testing. Do not cache responses that can carry auth cookies.

## Data model and permissions

`auth.users` has a one-to-one `profiles` row, and owns `habits` and `habit_logs`. The existing database uses RLS ownership policies, profile and timestamp triggers, and a composite ownership foreign key for logs. The approved Gate 2 privilege-hardening migration remains in effect. The application uses only the publishable key and the user's session; it never uses a service-role key or bypasses RLS.

The two recorded SQL migrations are already applied to the current hosted project. No migration or hosted settings are changed by Milestone 1. Further database or security changes require their own review and approval.

## Configuration and deployment

The two required variables are `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`, set in gitignored `.env.local` and Vercel. See README for Node 22, Auth redirect allow-list, PKCE same-browser, and SMTP requirements. Public variables are embedded at build time. GitHub/Vercel updates and Supabase Auth configuration are separate actions and require the appropriate authorization.
