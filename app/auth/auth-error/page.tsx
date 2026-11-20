import { redirect } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { Arrow } from "@/components/brand";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";
export const dynamic = "force-dynamic";
export default function AuthErrorPage() {
  if (isPhaseOneSimulation()) redirect("/dashboard");
  return <AuthShell eyebrow="LET'S TRY AGAIN" title="That link didn't work." description="Your link may have expired, already been used, or was opened in a different browser."><div className="notice notice-error">For security, open the latest email link in the same browser where you requested it.</div><div className="error-actions"><Link className="button button-primary button-wide" href="/login">Go to login <Arrow /></Link><Link className="text-link" href="/forgot-password">Request a new password reset ↗</Link><Link className="text-link" href="/resend-confirmation">Request a new verification email ↗</Link><Link className="text-link" href="/signup">Create an account ↗</Link></div></AuthShell>;
}
