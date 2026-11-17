import { NextResponse } from "next/server";
import { type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Auth callback handler.
 *
 * Exchanges a PKCE authorization code for a session. Future auth flows
 * must explicitly configure redirects and email templates accordingly.
 * It exchanges the one-time `code`
 * for a session, stores it in cookies, then redirects to `next`
 * (default: home).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const validationOrigin = "https://local.invalid";
  const code = searchParams.get("code");
  const requested = searchParams.get("next") ?? "/";
  // Permit only a same-origin path; reject scheme-relative URLs, backslashes,
  // and control characters which URL parsers may normalise into external URLs.
  let next = "/";
  if (requested.startsWith("/") && !requested.startsWith("//") && !/[\\\x00-\x1f\x7f]/.test(requested)) {
    const target = new URL(requested, validationOrigin);
    if (target.origin === validationOrigin) next = target.pathname + target.search + target.hash;
  }

  if (code && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    let response = new NextResponse(null, { status: 303, headers: { Location: next } });

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            response = new NextResponse(null, { status: 303, headers: { Location: next } });
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return response;
    }
  }

  return new NextResponse(null, { status: 303, headers: { Location: "/auth/auth-error" } });
}
