/**
 * Centralised access to environment variables.
 *
 * NEXT_PUBLIC_* variables are inlined into the client bundle at build time,
 * so they must be set before `next build` runs (locally via `.env.local`,
 * on Vercel via the dashboard's Environment Variables settings).
 *
 * This module never throws at import time — the app must still boot (and
 * render a helpful "not configured" state) before env vars are provided.
 */

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** True when both required Supabase variables are present. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

