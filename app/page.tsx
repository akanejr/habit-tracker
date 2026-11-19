import Link from "next/link";
import { Brand, Arrow } from "@/components/brand";
import { isPhaseOneSimulation } from "@/lib/phase1-mode";
export const dynamic = "force-dynamic";

export default function Home() {
  return <main className="landing">
    <header className="site-header"><Brand /><nav aria-label="Main navigation"><Link className="nav-login" href="/login">Log in</Link><Link className="button button-small" href="/signup">Get started <Arrow diagonal /></Link></nav></header>
    <section className="landing-hero">
      <div className="hero-copy"><p className="eyebrow"><span className="eyebrow-dot" /> A LITTLE BETTER, EVERY DAY</p><h1>Small steps.<br /><em>Beautiful</em><br />progress<span className="title-dot">.</span></h1><p className="hero-description">Build the habits that feel good, and let the little things add up to something wonderful.</p><div className="hero-actions">{isPhaseOneSimulation() && <Link className="button button-outline" href="/dashboard">Explore simulated Bloom <Arrow /></Link>}<Link className="button button-primary" href="/signup">Start your journey <Arrow /></Link><Link className="text-link" href="/login">I already have an account <span aria-hidden="true">↗</span></Link></div><div className="hero-caption"><span className="caption-star">✳</span><span>NO PRESSURE. JUST PROGRESS.</span></div></div>
      <div className="hero-art" aria-label="An illustration of a growing plant"><div className="art-top"><span>GROW AT YOUR OWN PACE</span><span>✳</span></div><div className="art-circle circle-one" /><div className="art-circle circle-two" /><div className="art-sun" /><svg className="plant" viewBox="0 0 360 400" fill="none" aria-hidden="true"><path d="M181 345c0-93 0-179 0-238" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/><path d="M181 258c-4-76-68-91-104-87 1 50 39 88 104 87Z" fill="currentColor"/><path d="M181 206c4-67 59-85 102-84-1 46-33 83-102 84Z" fill="currentColor"/><path d="M181 154c-3-45-32-77-59-89-9 40 6 79 59 89Z" fill="currentColor"/><path d="M181 126c3-48 35-70 64-78 4 38-13 70-64 78Z" fill="currentColor"/><path d="M117 344h128l-15 43h-98l-15-43Z" fill="currentColor"/><path d="M97 344h169" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg><div className="art-label"><span className="art-label-icon">✳</span><div><strong>Make room to grow</strong><small>One day at a time.</small></div></div><span className="art-number">01 / 01</span></div>
    </section><div className="landing-bottom"><p>THE BEST TIME TO BEGIN IS <em>RIGHT NOW.</em></p><span>SCROLL LESS. GROW MORE. &nbsp; ✳</span></div><footer className="site-footer"><span>© BLOOM HABIT TRACKER</span><span>MADE FOR EVERYDAY GROWTH</span></footer>
  </main>;
}
