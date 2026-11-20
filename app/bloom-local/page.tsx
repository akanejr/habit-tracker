import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { SessionsWorkspace } from "@/components/sessions/sessions-workspace";

// An explicitly enabled local-only development route. Never enable against a hosted project.
export const dynamic = "force-dynamic";
export default async function LocalSessionsPage() {
  if (process.env.BLOOM_LOCAL_SESSIONS_ENABLED !== "1" || !isSupabaseConfigured) notFound();
  let host = "";
  try { host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname; } catch { notFound(); }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) notFound();
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login?reason=session");
  return <SessionsWorkspace userId={user.id} />;
}
