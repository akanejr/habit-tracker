"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Brand } from "@/components/brand";
import { LogoutButton } from "@/components/auth/logout-button";
import { lagosDate, weekStart, friendlyDate } from "@/lib/habits/dates";
import { addDays, dailyHabitProgress, FOUR_HOURS_MS, timerDisplayMs, weeklySummary } from "@/lib/sessions/core";
import { executeCommand, loadWorkspace, type Command, type Habit, type SessionRow, type SegmentRow, type VersionRow } from "@/lib/sessions/client";
import { createClient } from "@/lib/supabase/client";

type Workspace = { habits: Habit[]; sessions: SessionRow[]; segments: SegmentRow[]; versions: VersionRow[] };
type Tab = "today" | "progress" | "settings";
const empty: Workspace = { habits: [], sessions: [], segments: [], versions: [] };
const pendingKey = (userId: string) => `bloom.local.pending.${userId}`;
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function SessionsWorkspace({ userId }: { userId: string }) {
  const client = useMemo(() => createClient(), []);
  const [data, setData] = useState<Workspace>(empty);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [pending, setPending] = useState<Command | null>(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>("today");
  const [detail, setDetail] = useState<string | null>(null);
  const [quick, setQuick] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | "new" | null>(null);
  const [week, setWeek] = useState(() => weekStart(lagosDate()));
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
  const [pendingReady, setPendingReady] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [dataReady, setDataReady] = useState(false);

  const refresh = useCallback(async () => { setData(await loadWorkspace(client, userId)); setDataReady(true); }, [client, userId]);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
    if (!alive) return;
    try {
      const raw = sessionStorage.getItem(pendingKey(userId));
      if (raw) setPending(JSON.parse(raw) as Command);
      const savedTheme = localStorage.getItem("bloom.local.theme");
      if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
      const probe = `${pendingKey(userId)}.probe`; sessionStorage.setItem(probe,"ok"); sessionStorage.removeItem(probe); setStorageReady(true);
    } catch { setMessage("Browser storage is unavailable. Session changes are disabled to prevent duplicate writes."); }
    setPendingReady(true);
    setOffline(!navigator.onLine);
    });
    loadWorkspace(client, userId).then(result => { if (alive) { setData(result); setDataReady(true); } }).catch(() => { if (alive) setMessage("Could not load sessions. Check the local database and try again."); }).finally(() => { if (alive) setLoading(false); });
    const updateOnline = () => setOffline(!navigator.onLine);
    window.addEventListener("online", updateOnline); window.addEventListener("offline", updateOnline);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); window.clearInterval(clock); };
  }, [client, userId]);

  async function command(cmd: Command, isRetry = false) {
    if (lock.current || (!isRetry && pending)) return;
    lock.current = true; setBusy(true); setMessage("");
    try {
      // Persist before dispatch: a lost response or refresh can safely retry the same payload.
      sessionStorage.setItem(pendingKey(userId), JSON.stringify(cmd));
      setPending(cmd);
      await executeCommand(client, cmd);
      sessionStorage.removeItem(pendingKey(userId)); setPending(null);
      setQuick(null); setCancelConfirm(false); setEdit(null); setArchiveConfirm(null);
      try { await refresh(); } catch { setMessage("Your action was saved, but the display could not refresh. Reload to see the latest state."); }
    } catch { setMessage("The result is uncertain. Retry the same request below; do not submit a new one until you have checked the history."); }
    finally { lock.current = false; setBusy(false); }
  }

  async function discardPending() {
    if (!window.confirm("Discard the saved retry? The action may already have succeeded. Check your history before repeating it.")) return;
    try { await refresh(); sessionStorage.removeItem(pendingKey(userId)); setPending(null); setMessage("Retry discarded. Review the refreshed history before repeating an action."); }
    catch { setMessage("Could not refresh. Keep the retry until you can check your history."); }
  }
  async function saveHabit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (lock.current || pending) return;
    const f = new FormData(event.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const description = String(f.get("description") ?? "").trim() || null;
    const preferred_time = String(f.get("preferred_time") ?? "") || null;
    if (!name || name.length > 120) { setMessage("Enter a habit name of up to 120 characters."); return; }
    if (edit === "new") await command({kind:"habit_create",request:crypto.randomUUID(),name,description,time:preferred_time});
    else if (edit) await command({kind:"habit_update",request:crypto.randomUUID(),habit:edit,name,description,time:preferred_time});
  }
  async function archiveHabit(id: string) {
    await command({kind:"habit_archive",request:crypto.randomUUID(),habit:id});
  }

  const today = lagosDate(new Date(now));
  const active = data.sessions.find(s => s.source === "timed" && (s.status === "running" || s.status === "paused"));
  const activeHabit = data.habits.find(h => h.id === active?.habit_id);
  let elapsed = 0, timerError = false;
  try { if (active) elapsed = timerDisplayMs(active, data.segments, now); } catch { timerError = true; }
  const enabled = !busy && !pending && pendingReady && storageReady && dataReady && !offline;
  const activeHabits = data.habits.filter(h => h.is_active);
  const progress = dailyHabitProgress(activeHabits.map(h => h.id), data.sessions, today);
  const selected = data.habits.find(h => h.id === detail);
  const selectedVersions = data.versions.filter(v => v.habit_id === detail).sort((a,b) => b.recorded_at.localeCompare(a.recorded_at));
  const selectedSessions = data.sessions.filter(s => s.habit_id === detail && s.status === "completed").sort((a,b) => (b.completed_on ?? "").localeCompare(a.completed_on ?? "") || b.created_at.localeCompare(a.created_at));
  const editHabit = data.habits.find(h => h.id === edit);
  return <div className={`bloom-workspace theme-${theme}`}>
    <header className="bloom-header"><Brand /><span>Local development · sessions</span><LogoutButton /></header>
    <main className="bloom-main">
      <div className="bloom-local-notice" role="note"><strong>Local development only.</strong> Goal scheduling and account deletion are not available. This is not a release.</div>
      <div className="bloom-actions"><button disabled={busy || offline} onClick={() => { setLoading(true); void refresh().then(() => setMessage("")).catch(() => setMessage("Could not refresh sessions. Try again when connected.")).finally(() => setLoading(false)); }}>Refresh data</button></div>
      {offline && <p className="bloom-alert" role="status">You appear to be offline. Actions are disabled; the timer display is an estimate until reconnected.</p>}
      {message && <p className="bloom-alert" role="alert">{message}</p>}
      {pending && <section className="bloom-panel" aria-label="Unconfirmed action"><h2>Action needs confirmation</h2><p>The last {pending.kind} request may have succeeded. Retrying uses the same request ID and input.</p><div className="bloom-actions"><button disabled={busy || offline} onClick={() => void command(pending, true)}>Retry safely</button><button disabled={busy || offline} onClick={() => void discardPending()}>Refresh and discard retry</button></div></section>}
      {loading ? <p role="status">Loading your habits and sessions…</p> : !dataReady ? <section className="bloom-panel"><p>Session data is not available; no data is being displayed as empty.</p><button onClick={() => { setLoading(true); void refresh().then(() => setMessage("")).catch(() => setMessage("Could not load sessions. Check the local database and try again.")).finally(() => setLoading(false)); }}>Retry loading</button></section> : <>
      {active && <section className="bloom-timer" aria-labelledby="timer-title"><p className="bloom-kicker">YOUR TIMER · {active.status.toUpperCase()}</p><h2 id="timer-title">{activeHabit?.name ?? "Habit"}{activeHabit && !activeHabit.is_active ? " · archived" : ""}</h2>{timerError ? <p role="alert">Timer state is inconsistent. Refresh before taking action.</p> : <p className="bloom-clock" aria-label={`Elapsed time ${duration(elapsed)}`}>{duration(elapsed)}</p>}<p>Elapsed display is an estimate. The server records the final time.</p>{elapsed >= FOUR_HOURS_MS && <p className="bloom-warning" role="status">This timer has run for four hours or more. It will keep running until you pause, complete or cancel it.</p>}<div className="bloom-actions"><button disabled={!enabled || timerError} onClick={() => void command({kind:active.status === "running" ? "pause" : "resume",session:active.id,request:crypto.randomUUID()})}>{active.status === "running" ? "Pause" : "Resume"}</button><button disabled={!enabled || timerError} onClick={() => void command({kind:"complete",session:active.id,request:crypto.randomUUID()})}>Complete</button><button disabled={!enabled} onClick={() => setCancelConfirm(true)}>Cancel timer</button></div>{cancelConfirm && <div className="bloom-confirm"><p>Cancel this timer without recording a completed session?</p><button disabled={!enabled} onClick={() => void command({kind:"cancel",session:active.id,request:crypto.randomUUID()})}>Yes, cancel timer</button> <button onClick={() => setCancelConfirm(false)}>Keep timer</button></div>}</section>}
      {tab === "today" && <><section className="bloom-heading"><p className="bloom-kicker">{friendlyDate(today)} · LAGOS</p><h1>Your space to grow<span>.</span></h1><p>{progress.completed} of {progress.total} active habits completed today. Multiple sessions are welcome.</p><button disabled={!enabled} onClick={() => setEdit("new")}>Add a habit</button></section><section aria-labelledby="habits-title"><h2 id="habits-title">Today’s habits</h2>{!activeHabits.length ? <p className="bloom-panel">No active habits yet. Add one to begin.</p> : <ul className="bloom-list">{activeHabits.map(h => {
        const count = data.sessions.filter(s => s.habit_id === h.id && s.status === "completed" && s.completed_on === today).length;
        return <li className="bloom-panel" key={h.id}><div><h3><button className="bloom-link" onClick={() => setDetail(h.id)}>{h.name}</button></h3><p>{count} {count === 1 ? "session" : "sessions"} today{h.preferred_time ? ` · preferred ${h.preferred_time.slice(0,5)}` : ""}</p></div><div className="bloom-actions"><button disabled={!enabled || Boolean(active)} onClick={() => void command({kind:"start",habit:h.id,request:crypto.randomUUID()})}>Start timer</button><button disabled={!enabled} onClick={() => setQuick(h.id)}>Quick Log</button><button onClick={() => setDetail(h.id)}>Details</button></div></li>;
      })}</ul>}</section></>}
      {tab === "progress" && <section><p className="bloom-kicker">MONDAY–SUNDAY · LAGOS</p><h1>Progress</h1><div className="bloom-actions"><button onClick={() => setWeek(addDays(week,-7))}>Previous week</button><strong>{week} to {addDays(week,6)}</strong><button disabled={week >= weekStart(today)} onClick={() => setWeek(addDays(week,7))}>Next week</button></div><p>Goal scheduling is unavailable; no target or achievement is assumed.</p><ul className="bloom-list">{data.habits.map(h => { const report = weeklySummary(data.sessions,h.id,week,{kind:"unconfirmed"}); return <li className="bloom-panel" key={h.id}><h3><button className="bloom-link" onClick={() => setDetail(h.id)}>{h.name}</button>{!h.is_active && " · archived"}</h3><p>{report.sessions} sessions · {report.activeDays} active days</p><p>Measured: {report.measuredMs === null ? "none recorded" : duration(report.measuredMs)} · Estimated: {report.estimatedMs === null ? "none recorded" : duration(report.estimatedMs)} · Unknown duration: {report.unknownDurationSessions}</p></li>; })}</ul>{data.habits.length === 0 && <p>No habits to report yet.</p>}</section>}
      {tab === "settings" && <section><p className="bloom-kicker">YOUR PREFERENCES</p><h1>Settings</h1><label>Theme <select value={theme} onChange={e => { const value = e.target.value as typeof theme; setTheme(value); try { localStorage.setItem("bloom.local.theme",value); } catch { setMessage("Theme preference could not be saved in this browser."); } }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label><div className="bloom-panel"><h2>Account deletion</h2><p>Self-service deletion is not available in this local build. No deletion request will be submitted.</p><button disabled>Delete account unavailable</button></div></section>}
      {selected && <section className="bloom-panel bloom-detail" aria-labelledby="detail-title"><div className="bloom-actions bloom-spread"><h2 id="detail-title">{selected.name}{!selected.is_active && " · archived"}</h2><button onClick={() => { setDetail(null); setArchiveConfirm(null); }}>Close details</button></div>{selected.description && <p>{selected.description}</p>}<p>Preferred time: {selected.preferred_time?.slice(0,5) ?? "not set"} · Goal scheduling unavailable</p>{selected.is_active && <div className="bloom-actions"><button disabled={!enabled} onClick={() => setEdit(selected.id)}>Edit</button><button disabled={!enabled} onClick={() => setArchiveConfirm(selected.id)}>Archive</button></div>}{archiveConfirm === selected.id && <div className="bloom-confirm"><p>Archive this habit? Its history remains, and an existing timer can still be completed or cancelled.</p><button disabled={!enabled} onClick={() => void archiveHabit(selected.id)}>Yes, archive</button> <button onClick={() => setArchiveConfirm(null)}>Keep habit</button></div>}<h3>Session history</h3>{!selectedSessions.length ? <p>No completed sessions yet.</p> : <ol className="bloom-history">{selectedSessions.map(s => <li key={s.id}><strong>{s.completed_on}</strong> · {s.source === "legacy" ? "Imported" : s.source === "quick" ? "Quick Log" : "Timed"} · {s.duration_ms !== null ? `${duration(s.duration_ms)} measured` : s.estimated_ms !== null ? `${duration(s.estimated_ms)} estimated` : "duration unknown"}{s.note && <p>{s.note}</p>}</li>)}</ol>}<h3>Known settings history</h3><p>Only versions recorded since history was enabled are available; earlier changes are unknown.</p>{selectedVersions.length === 0 ? <p>No settings history available.</p> : <ol className="bloom-history">{selectedVersions.map(v => <li key={v.id}><strong>{new Date(v.recorded_at).toLocaleString("en-GB",{timeZone:"Africa/Lagos"})} Lagos</strong> · {v.is_baseline ? "baseline · " : ""}{v.name} · {v.is_active ? "active" : "archived"} · preferred time {v.preferred_time?.slice(0,5) ?? "not set"}{v.description && <p>{v.description}</p>}<p>Legacy schedule: {v.frequency}{v.target_per_week === null ? "" : `, ${v.target_per_week} days per week`}. This is not a session goal.</p></li>)}</ol>}</section>}
      </>}
      {quick && <QuickForm habit={data.habits.find(h => h.id === quick)} today={today} disabled={!enabled} onClose={() => setQuick(null)} onSubmit={(date, estimatedMs, note) => void command({kind:"quick",request:crypto.randomUUID(),habit:quick,date,estimatedMs,note})} />}
      {edit && <section className="bloom-panel bloom-form" aria-labelledby="edit-title"><h2 id="edit-title">{edit === "new" ? "Create a habit" : "Edit habit"}</h2><form onSubmit={event => void saveHabit(event)}><label>Name <input name="name" required maxLength={120} defaultValue={editHabit?.name ?? ""} /></label><label>Description <textarea name="description" maxLength={500} defaultValue={editHabit?.description ?? ""} /></label><label>Preferred time in Lagos <input name="preferred_time" type="time" defaultValue={editHabit?.preferred_time?.slice(0,5) ?? ""} /></label><p>Weekly session goal selection is not available in this local build.</p><div className="bloom-actions"><button disabled={!enabled} type="submit">Save habit</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></div></form></section>}
    </main>
    <nav className="bloom-nav" aria-label="Main navigation">{(["today","progress","settings"] as const).map(t => <button key={t} aria-current={tab === t ? "page" : undefined} onClick={() => { setTab(t); setDetail(null); }}>{t[0].toUpperCase()+t.slice(1)}</button>)}</nav>
  </div>;
}

function QuickForm({ habit, today, disabled, onClose, onSubmit }: { habit: Habit | undefined; today: string; disabled: boolean; onClose: () => void; onSubmit: (date: string, estimatedMs: number | null, note: string | null) => void }) {
  const [error, setError] = useState("");
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const date = String(f.get("date") ?? ""); const minutes = String(f.get("minutes") ?? "").trim();
    try { addDays(date,0); } catch { setError("Enter a valid date."); return; }
    if (date > today) { setError("Choose today or an earlier date in Lagos."); return; }
    const estimated = minutes === "" ? null : Number(minutes) * 60000;
    if (estimated !== null && (!Number.isSafeInteger(estimated) || estimated < 0)) { setError("Enter a non-negative duration in minutes."); return; }
    const note = String(f.get("note") ?? "").trim() || null;
    setError(""); onSubmit(date,estimated,note);
  }
  return <section className="bloom-panel bloom-form" aria-labelledby="quick-title"><h2 id="quick-title">Quick Log · {habit?.name}</h2><p>You can log a session while a timer is running. Duration, if supplied, is an estimate.</p><form onSubmit={submit}><label>Lagos completion date <input name="date" type="date" required defaultValue={today} max={today} /></label><label>Estimated minutes (optional) <input name="minutes" type="number" min="0" step="1" /></label><label>Note (optional) <textarea name="note" maxLength={500} /></label>{error && <p role="alert">{error}</p>}<div className="bloom-actions"><button disabled={disabled} type="submit">Save session</button><button type="button" onClick={onClose}>Cancel</button></div></form></section>;
}
