"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Arrow } from "@/components/brand";

type Mode = "signup" | "login" | "forgot" | "reset" | "resend";

function messageFor(error: { message: string; code?: string }, mode: Mode) {
  const message = error.message.toLowerCase();
  if (error.code === "email_not_confirmed" || message.includes("email not confirmed")) return "Please verify your email before logging in. Check your inbox for the confirmation link.";
  if (error.code === "invalid_credentials" || message.includes("invalid login credentials")) return "That email and password don’t match. Please try again.";
  if (error.code === "email_address_invalid" || message.includes("email address") && message.includes("invalid")) return "Please enter a valid email address that can receive mail.";
  if (message.includes("email address not authorized") || error.code === "email_address_not_authorized") return "Email delivery is unavailable for this address. Please contact the app administrator.";
  if (message.includes("rate limit") || error.code?.includes("rate_limit")) return "Too many attempts. Please wait a little while and try again.";
  if (message.includes("sending confirmation email") || message.includes("sending recovery email")) return "We couldn’t send the email right now. Please try again later.";
  if (message.includes("password") && mode !== "login") return "Please choose a different password that meets the requirements.";
  if (message.includes("fetch") || message.includes("network")) return "We couldn’t reach the server. Check your connection and try again.";
  return "Something went wrong. Please try again in a moment.";
}

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(mode !== "reset");
  const [recoveryInvalid, setRecoveryInvalid] = useState(false);

  useEffect(() => {
    if (mode !== "reset") return;
    let active = true;
    createClient().auth.getUser().then(({ data, error }) => {
      if (active) { setRecoveryInvalid(Boolean(error || !data.user)); setRecoveryReady(true); }
    }).catch(() => { if (active) { setRecoveryInvalid(true); setRecoveryReady(true); } });
    return () => { active = false; };
  }, [mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (mode === "signup" && !name.trim()) { setError("Please enter your full name."); return; }
    if ((mode === "signup" || mode === "reset") && password.length < 8) { setError("Use at least 8 characters for your password."); return; }
    if ((mode === "signup" || mode === "reset") && password !== confirm) { setError("Your passwords don’t match. Please check them and try again."); return; }
    setBusy(true);
    try {
      const supabase = createClient();
      const callback = `${window.location.origin}/auth/callback`;
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { display_name: name.trim() }, emailRedirectTo: callback } });
        if (error) { setError(messageFor(error, mode)); return; }
        // Never equate a successful sign-up request with a verified email.
        if (data.session && data.user?.email_confirmed_at) { router.replace("/dashboard"); router.refresh(); return; }
        if (data.session) await supabase.auth.signOut({ scope: "local" });
        setComplete(true);
      } else if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) { setError(messageFor(error, mode)); return; }
        router.replace("/dashboard"); router.refresh();
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${callback}?next=/reset-password` });
        if (error) { setError(messageFor(error, mode)); return; }
        setComplete(true);
      } else if (mode === "resend") {
        const { error } = await supabase.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: callback } });
        if (error) { setError(messageFor(error, mode)); return; }
        setComplete(true);
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) { setError(messageFor(error, mode)); return; }
        // End the recovery session; the user signs in again with the new password.
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) { setError("Your password was updated, but we couldn’t sign you out. Please log out before signing in again."); return; }
        setComplete(true);
      }
    } catch {
      setError("We couldn’t complete that request. Check your connection and try again.");
    } finally { setBusy(false); }
  }

  if (mode === "reset" && !recoveryReady) return <p className="form-note" role="status">Checking your reset link…</p>;
  if (mode === "reset" && recoveryInvalid) return <div className="notice notice-error" role="alert">This reset link is invalid or has expired. <Link href="/forgot-password">Request a new link</Link>.</div>;
  if (complete) return (
    <div className="success-panel" role="status">
      <div className="success-icon" aria-hidden="true">✓</div>
      <h2>{mode === "reset" ? "Password updated" : "Check your inbox"}</h2>
      <p>{mode === "signup" || mode === "resend" ? "If this email can be registered or still needs verification, you’ll receive a confirmation link. Open it in this same browser to verify your email and finish signing up." : mode === "forgot" ? "If there’s an account for that email, you’ll receive a password reset link. Open it in this same browser to choose a new password." : "Your password has been changed. You can now log in with your new password."}</p>
      <Link href="/login" className="button button-primary button-wide">Go to login <Arrow /></Link>
      {mode !== "reset" && <p className="form-note">No email? Check your spam folder, or try again in a few minutes.</p>}
    </div>
  );

  const needsPassword = mode !== "forgot" && mode !== "resend";
  return (
    <form className="auth-form" onSubmit={submit}>
      {mode === "signup" && <label className="field"><span>Full name</span><input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={120} placeholder="Your name" /></label>}
      {mode !== "reset" && <label className="field"><span>Email address</span><input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} placeholder="you@example.com" /></label>}
      {needsPassword && <div className="field"><label htmlFor="auth-password">{mode === "reset" ? "New password" : "Password"}</label><span className="password-wrap"><input id="auth-password" type={visible ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === "login" ? undefined : 8} aria-describedby={mode === "login" ? undefined : "password-hint"} placeholder={mode === "login" ? "Enter your password" : "At least 8 characters"} /><button className="show-password" type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible}>{visible ? "Hide" : "Show"}</button></span>{mode !== "login" && <small id="password-hint">Use at least 8 characters. A longer, unique password is best.</small>}</div>}
      {(mode === "signup" || mode === "reset") && <label className="field"><span>Confirm password</span><input type={visible ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} placeholder="Enter your password again" /></label>}
      {mode === "login" && <div className="form-end"><Link href="/forgot-password">Forgot password?</Link></div>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <button className="button button-primary button-wide" type="submit" disabled={busy}>{busy ? "Just a moment…" : mode === "signup" ? "Create my account" : mode === "login" ? "Log in" : mode === "forgot" ? "Send reset link" : mode === "resend" ? "Send verification link" : "Update password"} <Arrow /></button>
      {mode === "signup" && <p className="form-note">By continuing, you’ll receive an email to verify your account.</p>}
      {(mode === "login" || mode === "signup") && <p className="auth-switch">{mode === "login" ? "New to Bloom?" : "Already have an account?"} <Link href={mode === "login" ? "/signup" : "/login"}>{mode === "login" ? "Create an account" : "Log in"} <span aria-hidden="true">↗</span></Link></p>}
      {mode === "login" && <p className="form-note center-note">Need a new verification email? <Link href="/resend-confirmation">Resend link</Link></p>}
      {(mode === "forgot" || mode === "resend") && <p className="auth-switch"><Link href="/login">Back to login ↗</Link></p>}
    </form>
  );
}
