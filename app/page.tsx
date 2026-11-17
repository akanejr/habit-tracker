import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, supabaseUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

type ConnectionStatus =
  | { status: "not-configured" }
  | { status: "connected" }
  | { status: "error"; message: string };

/**
 * Lightweight connectivity check against the hosted Supabase project.
 * Queries the `habits` table with the anon key — Row Level Security
 * returns an empty set (not an error) for signed-out visitors, so a
 * successful response proves the project is reachable and the schema
 * is applied.
 */
async function checkSupabaseConnection(): Promise<ConnectionStatus> {
  if (!isSupabaseConfigured) return { status: "not-configured" };

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("habits")
      .select("id", { head: true })
      .limit(1);
    if (error) return { status: "error", message: error.message };
    return { status: "connected" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

const FOUNDATION_ITEMS = [
  { label: "Next.js 16 (App Router) + React 19 + TypeScript", done: true },
  { label: "Supabase browser + server clients (@supabase/ssr)", done: true },
  { label: "Session-refresh proxy (proxy.ts)", done: true },
  { label: "Auth callback route (/auth/callback)", done: true },
  { label: "Database schema + RLS (profiles, habits, habit_logs)", done: true },
  { label: "Vercel-ready config (vercel.json, .nvmrc)", done: true },
  { label: "Sign-in / sign-up UI", done: false },
  { label: "Habit tracking interface", done: false },
];

export default async function HomePage() {
  const connection = await checkSupabaseConnection();

  return (
    <main className="container">
      <header className="hero">
        <h1>Habit Tracker</h1>
        <p className="subtitle">
          Project foundation — architecture and database foundations are in place. Authentication plumbing is prepared but not yet end-to-end tested. The habit-tracking interface comes next.
        </p>
      </header>

      <section className="card">
        <h2>Supabase connection</h2>
        {connection.status === "not-configured" && (
          <>
            <p className="status status-warn">⚠ Not configured</p>
            <p>
              Add your Supabase credentials to <code>.env.local</code> (see{" "}
              <code>.env.example</code>), then restart the dev server.
            </p>
          </>
        )}
        {connection.status === "connected" && (
          <>
            <p className="status status-ok">✓ Connected</p>
            <p>
              Reachable at <code>{supabaseUrl}</code>. The{" "}
              <code>habits</code> table responded successfully.
            </p>
          </>
        )}
        {connection.status === "error" && (
          <>
            <p className="status status-error">✗ Connection failed</p>
            <p>
              <code>{connection.message}</code>
            </p>
            <p>
              Check <code>.env.local</code> and confirm the schema migration
              has been applied (see <code>supabase/migrations/</code>).
            </p>
          </>
        )}
      </section>

      <section className="card">
        <h2>Foundation checklist</h2>
        <ul className="checklist">
          {FOUNDATION_ITEMS.map((item) => (
            <li key={item.label}>
              <span className={item.done ? "status-ok" : "status-pending"}>
                {item.done ? "✓" : "○"}
              </span>{" "}
              {item.label}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Next steps</h2>
        <ol>
          <li>
            Commit this repo to GitHub and import it into Vercel (see{" "}
            <code>README.md</code>).
          </li>
          <li>
            Add the same env vars in Vercel → Settings → Environment
            Variables.
          </li>
          <li>
            After the first deploy, set the Supabase Site URL + redirect
            allow list to your Vercel URL.
          </li>
          <li>Build the sign-in UI, then the habit-tracking interface.</li>
        </ol>
      </section>
    </main>
  );
}
