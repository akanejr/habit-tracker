import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Exchange the single-use PKCE code; only known local destinations are allowed. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next") === "/reset-password" ? "/reset-password" : "/dashboard";
  const response = new NextResponse(null, { status: 303, headers: { Location: "/auth/auth-error", "Cache-Control": "private, no-store, max-age=0", "Referrer-Policy": "no-referrer" } });
  if (!code || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return response;

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet, cacheHeaders) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(cacheHeaders).forEach(([name, value]) => response.headers.set(name, value));
        response.headers.set("Cache-Control", "private, no-store, max-age=0");
      },
    },
  });
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) response.headers.set("Location", next);
  } catch { /* Failed or expired links return the generic error page. */ }
  return response;
}
