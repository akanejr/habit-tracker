import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AccountDeletion } from "@/components/account/account-deletion";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  // In simulation mode, redirect to dashboard
  if (isPhaseOneSimulation()) {
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Get user profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, created_at")
    .eq("id", user.id)
    .single();

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <h1 className="text-3xl font-bold mb-8">Account Settings</h1>

      {/* Account Information */}
      <section className="mb-8 p-6 bg-white dark:bg-gray-800 rounded-lg shadow">
        <h2 className="text-xl font-semibold mb-4">Account Information</h2>
        <dl className="space-y-3">
          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Email</dt>
            <dd className="text-base text-gray-900 dark:text-gray-100">{user.email}</dd>
          </div>
          {profile?.display_name && (
            <div>
              <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Display Name</dt>
              <dd className="text-base text-gray-900 dark:text-gray-100">{profile.display_name}</dd>
            </div>
          )}
          <div>
            <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Account Created</dt>
            <dd className="text-base text-gray-900 dark:text-gray-100">
              {profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : "Unknown"}
            </dd>
          </div>
        </dl>
      </section>

      {/* Account Deletion */}
      <AccountDeletion userId={user.id} email={user.email || ""} />
    </div>
  );
}
