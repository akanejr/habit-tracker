import { AuthShell } from "@/components/auth/auth-shell";
import { AuthForm } from "@/components/auth/auth-form";
export default function SignupPage() { return <AuthShell eyebrow="LET’S BEGIN" title="A fresh start, just for you." description="Create your account and make a little room for good habits."><AuthForm mode="signup" /></AuthShell>; }
