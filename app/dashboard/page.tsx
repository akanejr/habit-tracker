import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { TodayDashboard } from "@/components/habits/today-dashboard";

export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login?reason=session");
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  return <TodayDashboard userId={user.id} displayName={profile?.display_name ?? null} />;
}
