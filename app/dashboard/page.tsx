import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { Brand } from "@/components/brand";
import { LogoutButton } from "@/components/auth/logout-button";

export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  if (!isSupabaseConfigured) redirect("/login");
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/login?reason=session");
  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  const name = profile?.display_name?.trim();
  return <main className="dashboard-page"><header className="site-header"><Brand /><LogoutButton /></header><section className="dashboard-welcome"><div className="welcome-symbol" aria-hidden="true">✳</div><p className="eyebrow">YOUR SPACE TO GROW</p><h1>Welcome{name ? `, ${name}` : ""}.<br /><em>Glad you’re here.</em></h1><p>Your account is ready. Your personal habit space is coming in the next milestone.</p><span className="dashboard-note"><span aria-hidden="true">✳</span> &nbsp; ONE DAY AT A TIME</span></section><footer className="site-footer"><span>© BLOOM HABIT TRACKER</span><span>MADE FOR EVERYDAY GROWTH</span></footer></main>;
}
