import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isSupabaseConfigured } from "@/lib/env";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";

// Protected routes that require authentication
const PROTECTED_ROUTES = ["/dashboard", "/bloom-phase1", "/bloom-local"];

// Auth routes that authenticated users should be redirected away from
const AUTH_ROUTES = ["/login", "/signup", "/forgot-password", "/reset-password", "/resend-confirmation"];

/**
 * Request proxy (Next.js 16 convention, formerly middleware.ts).
 * Runs before every page request to keep the Supabase session fresh and protect routes.
 */
export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // In simulation mode, allow all routes (Phase 1 demo mode)
  if (isPhaseOneSimulation()) {
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  }

  // If Supabase is not configured, allow all routes (development mode)
  if (!isSupabaseConfigured) {
    return NextResponse.next();
  }

  // Check if the route is protected
  const isProtectedRoute = PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  // Check if the route is an auth route
  const isAuthRoute = AUTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );

  // Create Supabase client for proxy
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    }
  );

  // Validate the session and refresh tokens if needed
  const { data: { user } } = await supabase.auth.getUser();

  // For protected routes, redirect to login if not authenticated
  if (isProtectedRoute && !user) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("reason", "session");
    loginUrl.searchParams.set("next", pathname);
    const redirectResponse = NextResponse.redirect(loginUrl);
    redirectResponse.headers.set("Cache-Control", "private, no-store, max-age=0");
    return redirectResponse;
  }

  // For auth routes, redirect to dashboard if already authenticated
  if (isAuthRoute && user) {
    const redirectResponse = NextResponse.redirect(new URL("/dashboard", request.url));
    redirectResponse.headers.set("Cache-Control", "private, no-store, max-age=0");
    return redirectResponse;
  }

  // Set cache control headers to prevent caching of authenticated responses
  if (user) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static, _next/image (static assets)
     * - favicon.ico
     * - files with an extension (e.g. .svg, .png, .jpg)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
