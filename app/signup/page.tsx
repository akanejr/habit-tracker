import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";
export const dynamic = "force-dynamic";
export default function SignupPage() {
  if (isPhaseOneSimulation()) redirect("/dashboard");
  return <AuthShell eyebrow="LET'S BEGIN" title="A fresh start, just for you." description="Create your account and make a little room for good habits."><AuthForm mode="signup" /></AuthShell>;
}
