/** Explicit synthetic UI mode; never use it alongside a configured hosted Supabase. */
export function isPhaseOneSimulation(): boolean {
  if (process.env.BLOOM_PHASE1_DEMO !== "1" || process.env.VERCEL_ENV === "production") return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return true;
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname); }
  catch { return false; }
}
