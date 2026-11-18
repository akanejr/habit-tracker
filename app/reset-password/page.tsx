import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
export default function ResetPasswordPage() { return <AuthShell eyebrow="A FRESH START" title="Choose a new password." description="Make it a good one. Your future self will thank you."><AuthForm mode="reset" /></AuthShell>; }
