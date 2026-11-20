import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";
export const dynamic = "force-dynamic";
export default function ResetPasswordPage() {
  if (isPhaseOneSimulation()) redirect("/dashboard");
  return <AuthShell eyebrow="A FRESH START" title="Choose a new password." description="Make it a good one. Your future self will thank you."><AuthForm mode="reset" /></AuthShell>;
}
