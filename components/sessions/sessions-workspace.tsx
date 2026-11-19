"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Brand } from "@/components/brand";
import { CalendarIcon, ChartIcon, SettingsIcon, SproutIcon } from "@/components/habits/icons";
import { LogoutButton } from "@/components/auth/logout-button";
import { lagosDate, weekStart, friendlyDate } from "@/lib/habits/dates";
import { addDays, dailyHabitProgress, FOUR_HOURS_MS, goalForWeek, timerDisplayMs, weeklySummary } from "@/lib/sessions/core";
import { executeCommand, loadWorkspace, type Command, type Habit, type SessionRow, type SegmentRow, type VersionRow } from "@/lib/sessions/client";
import { createClient } from "@/lib/supabase/client";
import { executeDemo, loadDemo, resetDemo, type DemoGoal } from "@/lib/sessions/phase1-mock";

type Workspace = { habits: Habit[]; sessions: SessionRow[]; segments: SegmentRow[]; versions: VersionRow[]; goals: DemoGoal[] };
type Tab = "today" | "progress" | "settings";
const empty: Workspace = { habits: [], sessions: [], segments: [], versions: [], goals: [] };
const pendingKey = (userId: string) => `bloom.local.pending.${userId}`;
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function SessionsWorkspace({ userId, demo = false }: { userId: string; demo?: boolean }) {
  const client = useMemo(() => demo ? null : createClient(), [demo]);
  const [data, setData] = useState<Workspace>(empty);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const currentUrl = useRef("");
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
  const [goalEdit, setGoalEdit] = useState<string | null>(null);
  const [warningDismissedFor, setWarningDismissedFor] = useState<string | null>(null);
  const [demoName, setDemoName] = useState("");
  const [profileDraft, setProfileDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const [success, setSuccess] = useState("");
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
  const [pendingReady, setPendingReady] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [dataReady, setDataReady] = useState(false);

  const load = useCallback(async (): Promise<Workspace> => demo ? loadDemo() : { ...await loadWorkspace(client!, userId), goals: [] }, [client, demo, userId]);
  const refresh = useCallback(async () => { setData(await load()); setDataReady(true); }, [load]);
  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(() => {
    if (!alive) return;
    try {
      const raw = sessionStorage.getItem(pendingKey(userId));
      if (raw) setPending(JSON.parse(raw) as Command);
      if (demo) { const name = localStorage.getItem("bloom.phase1.profile") ?? ""; setDemoName(name); setProfileDraft(name); }
      const savedTheme = localStorage.getItem("bloom.local.theme");
      if (savedTheme === "light" || savedTheme === "dark") setTheme(savedTheme);
      const probe = `${pendingKey(userId)}.probe`; sessionStorage.setItem(probe,"ok"); sessionStorage.removeItem(probe); setStorageReady(true);
    } catch { setMessage("Browser storage is unavailable. Session changes are disabled to prevent duplicate writes."); }
    setPendingReady(true);
    setOffline(!navigator.onLine);
    });
    load().then(result => { if (alive) { setData(result); setDataReady(true); } }).catch(() => { if (alive) setMessage("Could not load sessions. Check the local database and try again."); }).finally(() => { if (alive) setLoading(false); });
    const updateOnline = () => setOffline(!navigator.onLine);
    window.addEventListener("online", updateOnline); window.addEventListener("offline", updateOnline);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; window.removeEventListener("online", updateOnline); window.removeEventListener("offline", updateOnline); window.clearInterval(clock); };
  }, [demo, load, userId]);

  // The URL is the source of navigation history, so refresh and back/forward work.
  useEffect(() => { currentUrl.current = window.location.href; }, []);
  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const view = params.get("view");
      setTab(view === "progress" || view === "settings" ? view : "today");
      setDetail(params.get("habit"));
      setEdit(null); setQuick(null); setGoalEdit(null); setArchiveConfirm(null); setDraftDirty(false);
      setProfileDraft(demoName);
      currentUrl.current = window.location.href;
    };
    const handlePop = () => {
      if ((draftDirty || (tab === "settings" && profileDraft !== demoName)) && !window.confirm("Discard your unsaved changes?")) {
        window.history.pushState(null, "", currentUrl.current);
        return;
      }
      readLocation();
    };
    // Initial deep links are read only once, after hydration.
    if (!currentUrl.current) readLocation();
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [demoName, draftDirty, profileDraft, tab]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize a browser URL after hydration
    setTab(view === "progress" || view === "settings" ? view : "today");
    setDetail(params.get("habit"));
  }, []);
  useEffect(() => {
    if (!draftDirty && !(tab === "settings" && profileDraft !== demoName)) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [demoName, draftDirty, profileDraft, tab]);
  useEffect(() => {
    if (!demo) return;
    const sync = () => { void refresh().catch(() => setMessage("Could not refresh simulated data. Try again.")); };
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("storage", sync); window.removeEventListener("focus", sync); };
  }, [demo, refresh]);

  function abandonDraft() { return !(draftDirty || (tab === "settings" && profileDraft !== demoName)) || window.confirm("Discard your unsaved changes?"); }
  function navigate(view: Tab, habit: string | null = null) {
    if (!abandonDraft()) return;
    const url = new URL(window.location.href);
    if (view === "today") url.searchParams.delete("view"); else url.searchParams.set("view", view);
    if (habit) url.searchParams.set("habit", habit); else url.searchParams.delete("habit");
    window.history.pushState(null, "", url); currentUrl.current = url.href;
    setTab(view); setDetail(habit); setEdit(null); setQuick(null); setGoalEdit(null); setArchiveConfirm(null); setDraftDirty(false); setProfileDraft(demoName);
  }
  function openEdit(habit: string) { if (!abandonDraft()) return; setQuick(null); setGoalEdit(null); setDraftDirty(false); setEdit(habit); }
  function openQuick(habit: string) { if (!abandonDraft()) return; setEdit(null); setGoalEdit(null); setDraftDirty(false); setQuick(habit); }
  function openGoal(habit: string) { if (!abandonDraft()) return; setEdit(null); setQuick(null); setDraftDirty(false); setGoalEdit(habit); }
  function closeDraft(close: () => void) { if (abandonDraft()) { close(); setDraftDirty(false); } }

  useEffect(() => {
    const id = goalEdit ? "goal-title" : quick ? "quick-title" : edit ? "edit-title" : detail ? "detail-title" : null;
    if (id) { const frame = requestAnimationFrame(() => document.getElementById(id)?.focus()); return () => cancelAnimationFrame(frame); }
  }, [goalEdit, quick, edit, detail]);

  async function command(cmd: Command, isRetry = false) {
    if (lock.current || (!isRetry && pending)) return;
    lock.current = true; setBusy(true); setMessage(""); setSuccess("");
    try {
      // Persist before dispatch: a lost response or refresh can safely retry the same payload.
      sessionStorage.setItem(pendingKey(userId), JSON.stringify(cmd));
      setPending(cmd);
      if (demo) await executeDemo(cmd); else await executeCommand(client!, cmd);
      sessionStorage.removeItem(pendingKey(userId)); setPending(null);
      if (cmd.kind === "quick") { setQuick(null); setDraftDirty(false); }
      if (cmd.kind === "goal") { setGoalEdit(null); setDraftDirty(false); }
      if (cmd.kind === "habit_create" || cmd.kind === "habit_update") { setEdit(null); setDraftDirty(false); }
      if (cmd.kind === "habit_archive") setArchiveConfirm(null);
      if (cmd.kind === "cancel") setCancelConfirm(false);
      setSuccess(demo ? "Saved in this browser’s simulated workspace." : "Saved.");
      try { await refresh(); } catch { setMessage("Your action was saved, but the display could not refresh. Reload to see the latest state."); }
    } catch (error) {
      const maintenance = typeof error === "object" && error !== null && "code" in error && error.code === "55000";
      setMessage(maintenance ? "Maintenance or a pending dependency is preventing this action. Your request is saved; retry when service is available." : "The result is uncertain. Retry the same request below; do not submit a new one until you have checked the history.");
    }
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
  const goalLabel = (habitId: string, monday: string) => {
    if (!demo) return "Weekly session goal unavailable";
    try { const goal = goalForWeek(data.goals, habitId, monday); return goal.kind === "target" ? `${goal.value} sessions per week` : goal.kind === "none" ? "No weekly target" : "Weekly goal not confirmed"; }
    catch { return "Goal schedule pending"; }
  };
  const selected = data.habits.find(h => h.id === detail);
  const selectedVersions = data.versions.filter(v => v.habit_id === detail).sort((a,b) => b.recorded_at.localeCompare(a.recorded_at));
  const selectedSessions = data.sessions.filter(s => s.habit_id === detail && s.status === "completed").sort((a,b) => (b.completed_on ?? "").localeCompare(a.completed_on ?? "") || b.created_at.localeCompare(a.created_at));
  const editHabit = data.habits.find(h => h.id === edit);
  const scheduledGoals = data.goals.filter(g => g.habit_id === detail && g.effective_week !== null && g.effective_week > weekStart(today)).sort((a,b) => (b.effective_week ?? "").localeCompare(a.effective_week ?? "") || Number(b.id) - Number(a.id));
  return <div className={`bloom-workspace theme-${theme}`}>
    <header className="bloom-header"><Brand /><span>{demo ? "Phase 1 · interactive simulation" : "Local development · sessions"}</span>{!demo && <LogoutButton />}</header>
    <main className="bloom-main">
      <div className="bloom-local-notice" role="note">{demo ? <><strong>Simulation only.</strong> Data and timer timestamps are stored in this browser, not a server. Goals use a simulated clock; nothing here is production-ready or synced.</> : <><strong>Local development only.</strong> Goal scheduling and account deletion are not available. This is not a release.</>}</div>
      <div className="bloom-actions"><button disabled={busy || offline} onClick={() => { setLoading(true); void refresh().then(() => setMessage("")).catch(() => setMessage("Could not refresh sessions. Try again when connected.")).finally(() => setLoading(false)); }}>Refresh data</button></div>
      {offline && <p className="bloom-alert" role="status">You appear to be offline. Actions are disabled. A running timer is still running until a pause is confirmed; the displayed time is an estimate.</p>}
      {success && <p className="bloom-success" role="status">{success}</p>}
      {message && <p className="bloom-alert" role="alert">{message}</p>}
      {pending && <section className="bloom-panel" aria-label="Unconfirmed action"><h2>Action needs confirmation</h2><p>The last {pending.kind} request may have succeeded. Retrying uses the same request ID and input.</p><div className="bloom-actions"><button disabled={busy || offline} onClick={() => void command(pending, true)}>Retry safely</button><button disabled={busy || offline} onClick={() => void discardPending()}>Refresh and discard retry</button></div></section>}
      {loading ? <p role="status">Loading your habits and sessions…</p> : !dataReady ? <section className="bloom-panel"><p>Session data is not available; no data is being displayed as empty.</p><button onClick={() => { setLoading(true); void refresh().then(() => setMessage("")).catch(() => setMessage("Could not load sessions. Check the local database and try again.")).finally(() => setLoading(false)); }}>Retry loading</button></section> : <>
      {active && <section className="bloom-timer" aria-label="Current timer"><p className="bloom-kicker">YOUR TIMER · {active.status.toUpperCase()}</p><h2 id="timer-title">{activeHabit?.name ?? "Habit"}{activeHabit && !activeHabit.is_active ? " · archived" : ""}</h2>{timerError ? <p role="alert">Timer state is inconsistent. Refresh before taking action.</p> : <p className="bloom-clock" aria-label={`Elapsed time ${duration(elapsed)}`}>{duration(elapsed)}</p>}<p>{demo ? "Simulated timer: this browser’s clock records the time." : "Elapsed display is an estimate. The server records the final time."}</p>{elapsed >= FOUR_HOURS_MS && warningDismissedFor !== active.id && <div className="bloom-warning" role="status">This timer has run for four hours or more. It will keep running until you pause, complete or cancel it. <button onClick={() => setWarningDismissedFor(active.id)}>Continue timer</button></div>}<div className="bloom-actions"><button disabled={!enabled || timerError} onClick={() => void command({kind:active.status === "running" ? "pause" : "resume",session:active.id,request:crypto.randomUUID()})}>{active.status === "running" ? "Pause" : "Resume"}</button><button className="bloom-primary" disabled={!enabled || timerError} onClick={() => void command({kind:"complete",session:active.id,request:crypto.randomUUID()})}>Complete</button><button disabled={!enabled} onClick={() => setCancelConfirm(true)}>Cancel timer</button></div>{cancelConfirm && <div className="bloom-confirm"><p>Cancel this timer without recording a completed session?</p><button disabled={!enabled} onClick={() => void command({kind:"cancel",session:active.id,request:crypto.randomUUID()})}>Yes, cancel timer</button> <button onClick={() => setCancelConfirm(false)}>Keep timer</button></div>}</section>}
      {tab === "today" && <><section className="bloom-heading"><p className="bloom-kicker">{friendlyDate(today)} · LAGOS</p><h1>{demoName.trim() ? `Your space to grow, ${demoName.trim()}` : "Your space to grow"}<span>.</span></h1><p>Small steps, meaningful progress. Make a little room for what matters.</p><div className="bloom-daily-progress"><div className="bloom-progress-heading"><span>YOUR DAILY PROGRESS</span><strong>{progress.completed} / {progress.total} habits</strong></div><div className="bloom-progress-track" role="progressbar" aria-label="Today’s habit progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage}><span style={{width:`${progress.percentage}%`}} /></div><p>{progress.total ? "Completed habits today · multiple sessions are welcome." : "Add a habit to begin. An empty day is not counted as complete."}</p></div><button className="bloom-primary" disabled={!enabled} onClick={() => openEdit("new")}>Add a habit</button></section><section aria-labelledby="habits-title"><div className="bloom-section-heading"><div><p className="bloom-kicker">A MOMENT FOR YOU</p><h2 id="habits-title">Today’s habits <span>{activeHabits.length}</span></h2></div></div>{!activeHabits.length ? <p className="bloom-panel">No active habits yet. Add one to begin.</p> : <ul className="bloom-list">{activeHabits.map(h => {
        const count = data.sessions.filter(s => s.habit_id === h.id && s.status === "completed" && s.completed_on === today).length;
        return <li className="bloom-panel bloom-habit-card" key={h.id}><div className="bloom-habit-heading"><span className="bloom-habit-icon"><SproutIcon aria-hidden="true" /></span><div><h3 id={`habit-title-${h.id}`}>{h.name}</h3><p>{count} {count === 1 ? "session" : "sessions"} today · {goalLabel(h.id, weekStart(today))}{h.preferred_time ? ` · preferred ${h.preferred_time.slice(0,5)}` : ""}</p></div></div><div className="bloom-actions"><button aria-describedby={`habit-title-${h.id}`} className="bloom-primary" disabled={!enabled || Boolean(active)} onClick={() => void command({kind:"start",habit:h.id,request:crypto.randomUUID()})}>Start timer</button><button aria-describedby={`habit-title-${h.id}`} disabled={!enabled} onClick={() => openQuick(h.id)}>Quick Log</button><button aria-describedby={`habit-title-${h.id}`} onClick={() => navigate(tab, h.id)}>Details</button></div></li>;
      })}</ul>}</section></>}
      {tab === "progress" && <section><p className="bloom-kicker">MONDAY–SUNDAY · LAGOS</p><h1>Progress</h1><div className="bloom-actions"><button onClick={() => setWeek(addDays(week,-7))}>Previous week</button><strong>{week} to {addDays(week,6)}</strong><button disabled={week >= weekStart(today)} onClick={() => setWeek(addDays(week,7))}>Next week</button></div><p>{demo ? "Goals below are simulated; changes begin next full Lagos week." : "Goal scheduling is unavailable; no target or achievement is assumed."}</p><ul className="bloom-list">{data.habits.map(h => { let goal: ReturnType<typeof goalForWeek> = {kind:"unconfirmed"}; let unresolved = false; try { if (demo) goal = goalForWeek(data.goals,h.id,week); } catch { unresolved = true; } const report = weeklySummary(data.sessions,h.id,week,goal); return <li className="bloom-panel" key={h.id}><h2 className="bloom-report-habit"><button className="bloom-link" onClick={() => navigate(tab, h.id)}>{h.name}</button>{!h.is_active && " · archived"}</h2><p>{report.sessions} {report.sessions === 1 ? "session" : "sessions"} · {report.activeDays} active {report.activeDays === 1 ? "day" : "days"}</p><p>{unresolved ? "Goal schedule pending; counts remain available." : goal.kind === "target" ? `Weekly target: ${goal.value} sessions${report.achieved ? " · achieved" : ""}` : goal.kind === "none" ? "No weekly target confirmed" : "Weekly goal not confirmed"}</p><p>Total time invested: {report.measuredMs === null && report.estimatedMs === null ? "none recorded" : duration((report.measuredMs ?? 0) + (report.estimatedMs ?? 0))}</p><p>Measured: {report.measuredMs === null ? "none recorded" : duration(report.measuredMs)} · Estimated: {report.estimatedMs === null ? "none recorded" : duration(report.estimatedMs)} · Unknown duration: {report.unknownDurationSessions}</p></li>; })}</ul>{data.habits.length === 0 && <p>No habits to report yet.</p>}</section>}
      {tab === "settings" && <section><p className="bloom-kicker">YOUR PREFERENCES</p><h1>Settings</h1><label>Theme <select value={theme} onChange={e => { const value = e.target.value as typeof theme; setTheme(value); try { localStorage.setItem("bloom.local.theme",value); } catch { setMessage("Theme preference could not be saved in this browser."); } }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>{demo && <div className="bloom-panel bloom-form"><h2>Simulated profile</h2><form onSubmit={e => { e.preventDefault(); try { localStorage.setItem("bloom.phase1.profile", profileDraft.trim()); setDemoName(profileDraft.trim()); setProfileDraft(profileDraft.trim()); setSuccess("Simulated profile saved in this browser."); } catch { setMessage("Could not save the simulated profile."); } }}><label>Display name <input maxLength={80} value={profileDraft} onChange={e => setProfileDraft(e.target.value)} /></label><button type="submit">Save profile</button></form><p>This does not update a real account.</p></div>}{demo && <div className="bloom-panel"><h2>Demo data</h2><p>This workspace is simulated and kept only in this browser.</p><button disabled={!enabled} onClick={() => { if (window.confirm("Erase all simulated data in this browser?")) { resetDemo(); setDemoName(""); setProfileDraft(""); sessionStorage.removeItem(pendingKey(userId)); setPending(null); void refresh(); setSuccess("Simulated data cleared."); } }}>Reset simulated data</button></div>}<div className="bloom-panel"><h2>Account deletion</h2><p>Self-service deletion is not available in this local build. No deletion request will be submitted.</p><button disabled>Delete account unavailable</button></div></section>}
      {detail && !selected && <section className="bloom-panel"><h2>Habit not found</h2><p>This habit is not available in this workspace.</p><button onClick={() => navigate(tab)}>Back to {tab}</button></section>}
      {selected && <section className="bloom-panel bloom-detail" aria-labelledby="detail-title"><div className="bloom-actions bloom-spread"><h2 id="detail-title" tabIndex={-1}>{selected.name}{!selected.is_active && " · archived"}</h2><button onClick={() => { navigate(tab); }}>Close details</button></div>{selected.description && <p>{selected.description}</p>}<p>Preferred time: {selected.preferred_time?.slice(0,5) ?? "not set"} · {demo ? "Session goals are simulated" : "Goal scheduling unavailable"}</p>{demo && <p>Current week: {goalLabel(selected.id, weekStart(today))}.</p>}{demo && <p>{scheduledGoals.length ? `Scheduled from ${scheduledGoals[0].effective_week}: ${scheduledGoals[0].weekly_session_target === null ? "No weekly target" : `${scheduledGoals[0].weekly_session_target} sessions per week`}.` : "No upcoming simulated goal change."}</p>}{demo && selected.is_active && <button disabled={!enabled} onClick={() => openGoal(selected.id)}>Set weekly session goal</button>}{selected.is_active && <div className="bloom-actions"><button disabled={!enabled} onClick={() => openEdit(selected.id)}>Edit</button><button disabled={!enabled} onClick={() => { if (abandonDraft()) { setEdit(null); setQuick(null); setGoalEdit(null); setDraftDirty(false); setArchiveConfirm(selected.id); } }}>Archive</button></div>}{archiveConfirm === selected.id && <div className="bloom-confirm"><p>Archive this habit? Its history remains, and an existing timer can still be completed or cancelled.</p><button disabled={!enabled} onClick={() => void archiveHabit(selected.id)}>Yes, archive</button> <button onClick={() => setArchiveConfirm(null)}>Keep habit</button></div>}<h3>Session history</h3>{!selectedSessions.length ? <p>No completed sessions yet.</p> : <ol className="bloom-history">{selectedSessions.map(s => <li key={s.id}><strong>{s.completed_on}</strong> · {s.source === "legacy" ? "Imported" : s.source === "quick" ? "Quick Log" : "Timed"} · {s.duration_ms !== null ? `${duration(s.duration_ms)} measured` : s.estimated_ms !== null ? `${duration(s.estimated_ms)} estimated` : "duration unknown"}<p>Recorded {new Date(s.created_at).toLocaleString("en-GB", { timeZone: "Africa/Lagos" })} Lagos{data.versions.find(v => v.id === s.completion_version_id) ? ` · known name: ${data.versions.find(v => v.id === s.completion_version_id)!.name}` : ""}</p>{s.note && <p>{s.note}</p>}</li>)}</ol>}{demo && <><h3>Simulated goal history</h3>{data.goals.filter(g => g.habit_id === selected.id).length ? <ol className="bloom-history">{data.goals.filter(g => g.habit_id === selected.id).slice().reverse().map(g => <li key={g.id}>From {g.effective_week ?? "pending"}: {g.weekly_session_target === null ? "No weekly target" : `${g.weekly_session_target} sessions per week`}</li>)}</ol> : <p>No session goal has been confirmed.</p>}</>}<h3>Known settings history</h3><p>Only versions recorded since history was enabled are available; earlier changes are unknown.</p>{selectedVersions.length === 0 ? <p>No settings history available.</p> : <ol className="bloom-history">{selectedVersions.map(v => <li key={v.id}><strong>{new Date(v.recorded_at).toLocaleString("en-GB",{timeZone:"Africa/Lagos"})} Lagos</strong> · {v.is_baseline ? "baseline · " : ""}{v.name} · {v.is_active ? "active" : "archived"} · preferred time {v.preferred_time?.slice(0,5) ?? "not set"}{v.description && <p>{v.description}</p>}<p>Legacy schedule: {v.frequency}{v.target_per_week === null ? "" : `, ${v.target_per_week} days per week`}. This is not a session goal.</p></li>)}</ol>}</section>}
      </>}
      {goalEdit && <GoalForm key={goalEdit} habit={data.habits.find(h => h.id === goalEdit)} disabled={!enabled} onClose={() => closeDraft(() => setGoalEdit(null))} onDirty={() => setDraftDirty(true)} onSubmit={target => void command({kind:"goal",request:crypto.randomUUID(),habit:goalEdit,target})} />}
      {quick && <QuickForm key={quick} habit={data.habits.find(h => h.id === quick)} today={today} disabled={!enabled} onClose={() => closeDraft(() => setQuick(null))} onDirty={() => setDraftDirty(true)} onSubmit={(date, estimatedMs, note) => void command({kind:"quick",request:crypto.randomUUID(),habit:quick,date,estimatedMs,note})} />}
      {edit && <section key={edit} className="bloom-panel bloom-form" aria-labelledby="edit-title"><h2 id="edit-title" tabIndex={-1}>{edit === "new" ? "Create a habit" : "Edit habit"}</h2><form onChange={() => setDraftDirty(true)} onSubmit={event => void saveHabit(event)}><label>Name <input name="name" disabled={!enabled} required maxLength={120} defaultValue={editHabit?.name ?? ""} /></label><label>Description <textarea name="description" disabled={!enabled} maxLength={500} defaultValue={editHabit?.description ?? ""} /></label><label>Preferred time in Lagos <input name="preferred_time" disabled={!enabled} type="time" defaultValue={editHabit?.preferred_time?.slice(0,5) ?? ""} /></label><p>{demo ? "After creating a habit, open its details to confirm a weekly session goal." : "Weekly session goal selection is not available in this local build."}</p><div className="bloom-actions"><button className="bloom-primary" disabled={!enabled} type="submit">Save habit</button><button type="button" onClick={() => closeDraft(() => setEdit(null))}>Cancel</button></div></form></section>}
    </main>
    <nav className="bloom-nav" aria-label="Main navigation">{(["today","progress","settings"] as const).map(t => { const Icon = t === "today" ? CalendarIcon : t === "progress" ? ChartIcon : SettingsIcon; return <button key={t} aria-current={tab === t ? "page" : undefined} onClick={() => navigate(t)}><Icon aria-hidden="true" /><span>{t[0].toUpperCase()+t.slice(1)}</span></button>; })}</nav>
  </div>;
}

function QuickForm({ habit, today, disabled, onClose, onDirty, onSubmit }: { habit: Habit | undefined; today: string; disabled: boolean; onClose: () => void; onDirty: () => void; onSubmit: (date: string, estimatedMs: number | null, note: string | null) => void }) {
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
  return <section className="bloom-panel bloom-form" aria-labelledby="quick-title"><h2 id="quick-title" tabIndex={-1}>Quick Log · {habit?.name}</h2><p>You can log a session while a timer is running. Duration, if supplied, is an estimate.</p><form onChange={onDirty} onSubmit={submit}><label>Lagos completion date <input name="date" type="date" disabled={disabled} required defaultValue={today} max={today} /></label><label>Estimated minutes (optional) <input name="minutes" disabled={disabled} type="number" min="0" step="1" /></label><label>Note (optional) <textarea name="note" disabled={disabled} maxLength={500} /></label>{error && <p role="alert">{error}</p>}<div className="bloom-actions"><button className="bloom-primary" disabled={disabled} type="submit">Save session</button><button type="button" onClick={onClose}>Cancel</button></div></form></section>;
}

function GoalForm({ habit, disabled, onClose, onDirty, onSubmit }: { habit: Habit | undefined; disabled: boolean; onClose: () => void; onDirty: () => void; onSubmit: (target: number | null) => void }) {
  const [choice, setChoice] = useState<"target" | "none">("target");
  const [error, setError] = useState("");
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get("target") ?? "");
    if (choice === "target" && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1)) { setError("Enter a whole number of sessions greater than zero."); return; }
    onSubmit(choice === "none" ? null : Number(raw));
  }
  return <section className="bloom-panel bloom-form" aria-labelledby="goal-title"><h2 id="goal-title" tabIndex={-1}>Confirm a session goal · {habit?.name}</h2><p>This simulation applies the choice next full Lagos week. The current week does not change.</p><form onChange={onDirty} onSubmit={submit}><fieldset disabled={disabled}><legend>Weekly session goal</legend><label><input type="radio" name="goal-choice" checked={choice === "target"} onChange={() => setChoice("target")} /> Set a target</label><label><input type="radio" name="goal-choice" checked={choice === "none"} onChange={() => setChoice("none")} /> No weekly target</label></fieldset>{choice === "target" && <label>Sessions per week <input name="target" disabled={disabled} type="number" min="1" step="1" required /></label>}{error && <p role="alert">{error}</p>}<div className="bloom-actions"><button className="bloom-primary" disabled={disabled} type="submit">Confirm goal</button><button type="button" onClick={onClose}>Cancel</button></div></form></section>;
}
