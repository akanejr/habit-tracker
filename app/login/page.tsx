import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  return <AuthShell eyebrow="WELCOME BACK" title="Good to see you again." description="Pick up right where you left off.">{reason === "session" && <p className="notice notice-info" role="status">Please log in to continue. Your session may have expired.</p>}<AuthForm mode="login" /></AuthShell>;
}
