import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
export default function ForgotPasswordPage() { return <AuthShell eyebrow="NO WORRIES" title="Forgot your password?" description="It happens. Enter your email and we’ll send you a link to reset it."><AuthForm mode="forgot" /></AuthShell>; }
