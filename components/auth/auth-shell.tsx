import Link from "next/link";
import { Brand } from "@/components/brand";

export function AuthShell({ children, eyebrow, title, description }: { children: React.ReactNode; eyebrow: string; title: string; description: string }) {
  return (
    <main className="auth-layout">
      <aside className="auth-aside">
        <Brand light />
        <div className="aside-copy">
          <div className="aside-orbit" aria-hidden="true"><span>✳</span></div>
          <p className="aside-kicker">A LITTLE BETTER, EVERY DAY</p>
          <h2>Good things<br /><em>grow slowly.</em></h2>
          <p>Make space for the habits that matter, one small step at a time.</p>
        </div>
        <div className="aside-footer"><span>YOUR SPACE TO GROW</span><span>✳ &nbsp; BLOOM</span></div>
      </aside>
      <section className="auth-main">
        <div className="mobile-brand"><Brand /></div>
        <div className="auth-inner">
          <Link className="back-link" href="/">← <span>Back to home</span></Link>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="auth-description">{description}</p>
          {children}
        </div>
        <p className="auth-bottom">A little progress is still progress. <span>✳</span></p>
      </section>
    </main>
  );
}
