import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";
export const dynamic = "force-dynamic";
export default function ResendConfirmationPage() {
  if (isPhaseOneSimulation()) redirect("/dashboard");
  return <AuthShell eyebrow="LET'S TRY AGAIN" title="Need a new link?" description="Enter your email and we'll resend your account verification link."><AuthForm mode="resend" /></AuthShell>;
}
