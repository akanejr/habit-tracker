import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";
export const dynamic = "force-dynamic";
export default function ForgotPasswordPage() {
  if (isPhaseOneSimulation()) redirect("/dashboard");
  return <AuthShell eyebrow="NO WORRIES" title="Forgot your password?" description="It happens. Enter your email and we'll send you a link to reset it."><AuthForm mode="forgot" /></AuthShell>;
}
