import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Request proxy (Next.js 16 convention, formerly middleware.ts).
 * Runs before every page request to keep the Supabase session fresh.
 */
export default async function proxy(request: NextRequest) {
  // The opt-in synthetic UX sandbox must not contact hosted Auth.
  if (request.nextUrl.pathname === "/bloom-phase1" && process.env.BLOOM_PHASE1_DEMO === "1") {
    const response = NextResponse.next(); response.headers.set("Cache-Control", "private, no-store"); return response;
  }
  return await updateSession(request);
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
