import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
export default function ResendConfirmationPage() { return <AuthShell eyebrow="LET’S TRY AGAIN" title="Need a new link?" description="Enter your email and we’ll resend your account verification link."><AuthForm mode="resend" /></AuthShell>; }
