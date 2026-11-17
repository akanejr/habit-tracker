import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database";

/**
 * Server-side Supabase client (Server Components, Route Handlers,
 * Server Actions). Keeps the session in sync via cookies.
 *
 * Callers should check `isSupabaseConfigured` from `@/lib/env` before
 * using this client so the app can render a setup state when env vars
 * are missing.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component — session refresh is handled
            // by the proxy (see /proxy.ts). Safe to ignore here.
          }
        },
      },
    }
  );
}
