import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { TodayDashboard } from "@/components/habits/today-dashboard";
import { SessionsWorkspace } from "@/components/sessions/sessions-workspace";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";

export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  // Explicit, local synthetic mode; never read or write the real account.
  if (isPhaseOneSimulation()) return <SessionsWorkspace userId="phase1-synthetic-user" demo />;
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login?reason=session");
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  return <TodayDashboard userId={user.id} displayName={profile?.display_name ?? null} />;
}
