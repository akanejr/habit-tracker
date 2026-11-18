"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function logout() {
    setBusy(true); setError("");
    try {
      const { error } = await createClient().auth.signOut({ scope: "local" });
      if (error) { setError("Couldn’t log out. Please try again."); return; }
      router.replace("/login"); router.refresh();
    } catch { setError("Couldn’t log out. Check your connection and try again."); }
    finally { setBusy(false); }
  }
  return <div className="logout-wrap"><button className="button button-outline" onClick={logout} disabled={busy}>{busy ? "Logging out…" : "Log out"}</button>{error && <p className="notice notice-error" role="alert">{error}</p>}</div>;
}
