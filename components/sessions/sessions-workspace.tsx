"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
const detailsHref = (view: Tab, habit: string) => {
  const params = new URLSearchParams();
  if (view !== "today") params.set("view", view);
  params.set("habit", habit);
  return `/dashboard?${params.toString()}`;
};
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
const sessionCountLabel = (count: number) => `${count} ${count === 1 ? "session" : "sessions"}`;
function sumSessionDuration(sessions: readonly SessionRow[], field: "duration_ms" | "estimated_ms"): number | null {
  let total = 0, found = false;
  for (const session of sessions) {
    const value = session[field];
    if (value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid session duration");
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("Session duration total is too large");
    found = true;
  }
  return found ? total : null;
}

export function SessionsWorkspace({ userId, demo = false }: { userId: string; demo?: boolean }) {
  const client = useMemo(() => demo ? null : createClient(), [demo]);
  const [data, setData] = useState<Workspace>(empty);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const currentUrl = useRef("");
  const detailOrigin = useRef<{ view: Tab; scrollY: number } | null>(null);
  const [pending, setPending] = useState<Command | null>(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [tab, setTab] = useState<Tab>("today");
  const [detail, setDetail] = useState<string | null>(null);
  const [quick, setQuick] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | "new" | null>(null);
  const [week, setWeek] = useState(() => weekStart(lagosDate()));
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [cancelConfirm, setCancelConfirm] = useState<string | null>(null);
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
      let wasOnDetails = false;
      try { wasOnDetails = currentUrl.current ? new URL(currentUrl.current).searchParams.has("habit") : false; } catch { /* ignore an unavailable previous URL */ }
      const isLeavingDetails = wasOnDetails && !new URLSearchParams(window.location.search).has("habit");
      const restoreScrollY = isLeavingDetails ? detailOrigin.current?.scrollY : undefined;
      readLocation();
      if (restoreScrollY !== undefined) window.requestAnimationFrame(() => window.scrollTo(0, restoreScrollY));
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
    if (habit) detailOrigin.current = { view, scrollY: window.scrollY };
    else if (detail) detailOrigin.current = null;
    const url = new URL(window.location.href);
    if (view === "today") url.searchParams.delete("view"); else url.searchParams.set("view", view);
    if (habit) url.searchParams.set("habit", habit); else url.searchParams.delete("habit");
    window.history.pushState(null, "", url); currentUrl.current = url.href;
    setTab(view); setDetail(habit); setEdit(null); setQuick(null); setGoalEdit(null); setArchiveConfirm(null); setDraftDirty(false); setProfileDraft(demoName);
  }
  function closeDetails() {
    if (!abandonDraft()) return;
    const view = detailOrigin.current?.view ?? tab;
    const scrollY = detailOrigin.current?.scrollY ?? 0;
    const url = new URL(window.location.href);
    if (view === "today") url.searchParams.delete("view"); else url.searchParams.set("view", view);
    url.searchParams.delete("habit");
    window.history.replaceState(null, "", url); currentUrl.current = url.href;
    detailOrigin.current = null;
    setTab(view); setDetail(null); setEdit(null); setQuick(null); setGoalEdit(null); setArchiveConfirm(null); setDraftDirty(false); setProfileDraft(demoName);
    window.requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }
  function openEdit(habit: string) { if (!abandonDraft()) return; setQuick(null); setGoalEdit(null); setDraftDirty(false); setEdit(habit); }
  function openQuick(habit: string) { if (!abandonDraft()) return; setEdit(null); setGoalEdit(null); setDraftDirty(false); setQuick(habit); }
  function openGoal(habit: string) { if (!abandonDraft()) return; setEdit(null); setQuick(null); setDraftDirty(false); setGoalEdit(habit); }
  function requestArchive(habit: string) { if (!abandonDraft()) return; setEdit(null); setQuick(null); setGoalEdit(null); setDraftDirty(false); setArchiveConfirm(habit); }
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
      if (cmd.kind === "cancel") setCancelConfirm(null);
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
  // Every view reads this same persisted session and segment list; `now` is display interpolation only.
  const active = data.sessions.find(s => s.source === "timed" && (s.status === "running" || s.status === "paused"));
  const activeHabit = data.habits.find(h => h.id === active?.habit_id);
  const selected = data.habits.find(h => h.id === detail);
  const hasDetailsTimer = Boolean(active && detail && selected && activeHabit);
  const hasTodayTimerCard = tab === "today" && !detail && Boolean(active && activeHabit?.is_active);
  const showGlobalTimer = Boolean(active && !hasTodayTimerCard && !hasDetailsTimer);
  let elapsed = 0, timerError = false;
  try { if (active) elapsed = timerDisplayMs(active, data.segments, now); } catch { timerError = true; }
  const enabled = !busy && !pending && pendingReady && storageReady && dataReady && !offline;
  const activeHabits = data.habits.filter(h => h.is_active);
  const progress = dailyHabitProgress(activeHabits.map(h => h.id), data.sessions, today);
  const goalLabel = (habitId: string, monday: string) => {
    if (!demo) return "Weekly session goal unavailable";
    try { const goal = goalForWeek(data.goals, habitId, monday); return goal.kind === "target" ? `${sessionCountLabel(goal.value)} per week` : goal.kind === "none" ? "No weekly target" : "Weekly goal not confirmed"; }
    catch { return "Goal schedule pending"; }
  };
  const selectedVersions = data.versions.filter(v => v.habit_id === detail).sort((a,b) => b.recorded_at.localeCompare(a.recorded_at));
  const selectedSessions = data.sessions.filter(s => s.habit_id === detail && s.status === "completed").sort((a,b) => (b.completed_on ?? "").localeCompare(a.completed_on ?? "") || b.created_at.localeCompare(a.created_at));
  const selectedCompletedCount = new Set(selectedSessions.map(s => s.id)).size;
  const selectedActiveDayCount = new Set(selectedSessions.map(s => s.completed_on).filter((day): day is string => day !== null)).size;
  const selectedMeasuredMs = sumSessionDuration(selectedSessions, "duration_ms");
  const selectedEstimatedMs = sumSessionDuration(selectedSessions, "estimated_ms");
  const selectedUnknownDurationCount = selectedSessions.filter(s => s.duration_ms === null && s.estimated_ms === null).length;
  const detailsWeek = weekStart(today);
  let detailsGoal: ReturnType<typeof goalForWeek> = {kind:"unconfirmed"};
  let detailsGoalPending = false;
  if (demo && selected) {
    try { detailsGoal = goalForWeek(data.goals, selected.id, detailsWeek); }
    catch { detailsGoalPending = true; }
  }
  const detailsWeekSummary = selected ? weeklySummary(data.sessions, selected.id, detailsWeek, detailsGoal) : null;
  const editHabit = data.habits.find(h => h.id === edit);
  const scheduledGoals = data.goals.filter(g => g.habit_id === detail && g.effective_week !== null && g.effective_week > detailsWeek).sort((a,b) => (b.effective_week ?? "").localeCompare(a.effective_week ?? "") || Number(b.id) - Number(a.id));
  const detailBackLabel = tab[0].toUpperCase() + tab.slice(1);
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
      {active && showGlobalTimer && <ActiveSessionTimer session={active} habit={activeHabit} elapsed={elapsed} timerError={timerError} enabled={enabled} demo={demo} variant="panel" cancelConfirm={cancelConfirm} warningDismissed={warningDismissedFor === active.id} onToggle={() => void command({kind:active.status === "running" ? "pause" : "resume",session:active.id,request:crypto.randomUUID()})} onComplete={() => void command({kind:"complete",session:active.id,request:crypto.randomUUID()})} onRequestCancel={() => setCancelConfirm(active.id)} onCancel={() => void command({kind:"cancel",session:active.id,request:crypto.randomUUID()})} onKeepTimer={() => setCancelConfirm(null)} onContinue={() => setWarningDismissedFor(active.id)} />}
      {!detail && tab === "today" && <><section className="bloom-heading"><p className="bloom-kicker">{friendlyDate(today)} · LAGOS</p><h1>{demoName.trim() ? `Your space to grow, ${demoName.trim()}` : "Your space to grow"}<span>.</span></h1><p>Small steps, meaningful progress. Make a little room for what matters.</p><div className="bloom-daily-progress"><div className="bloom-progress-heading"><span>YOUR DAILY PROGRESS</span><strong>{progress.completed} / {progress.total} habits</strong></div><div className="bloom-progress-track" role="progressbar" aria-label="Today’s habit progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage}><span style={{width:`${progress.percentage}%`}} /></div><p>{progress.total ? "Completed habits today · multiple sessions are welcome." : "Add a habit to begin. An empty day is not counted as complete."}</p></div><button className="bloom-primary" disabled={!enabled} onClick={() => openEdit("new")}>Add a habit</button></section><section aria-labelledby="habits-title"><div className="bloom-section-heading"><div><p className="bloom-kicker">A MOMENT FOR YOU</p><h2 id="habits-title">Today’s habits <span>{activeHabits.length}</span></h2></div></div>{!activeHabits.length ? <p className="bloom-panel">No active habits yet. Add one to begin.</p> : <ul className="bloom-list">{activeHabits.map(h => {
        const count = data.sessions.filter(s => s.habit_id === h.id && s.status === "completed" && s.completed_on === today).length;
        const cardTimer = !detail && active?.habit_id === h.id ? active : null;
        return <li className={`bloom-panel bloom-habit-card${cardTimer ? " bloom-habit-card-active" : ""}`} key={h.id}><a className="bloom-habit-card-link" href={detailsHref(tab,h.id)} aria-label={`Open details for ${h.name}`} onClick={event => { if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate(tab,h.id); }} /><div className="bloom-habit-heading"><span className="bloom-habit-icon"><SproutIcon aria-hidden="true" /></span><div><h3 id={`habit-title-${h.id}`}>{h.name}</h3><p>{count} {count === 1 ? "session" : "sessions"} today · {goalLabel(h.id, weekStart(today))}{h.preferred_time ? ` · preferred ${h.preferred_time.slice(0,5)}` : ""}</p></div></div>{cardTimer && <ActiveSessionTimer session={cardTimer} habit={h} elapsed={elapsed} timerError={timerError} enabled={enabled} demo={demo} variant="card" cancelConfirm={cancelConfirm} warningDismissed={warningDismissedFor === cardTimer.id} onToggle={() => void command({kind:cardTimer.status === "running" ? "pause" : "resume",session:cardTimer.id,request:crypto.randomUUID()})} onComplete={() => void command({kind:"complete",session:cardTimer.id,request:crypto.randomUUID()})} onRequestCancel={() => setCancelConfirm(cardTimer.id)} onCancel={() => void command({kind:"cancel",session:cardTimer.id,request:crypto.randomUUID()})} onKeepTimer={() => setCancelConfirm(null)} onContinue={() => setWarningDismissedFor(cardTimer.id)} />}<div className="bloom-actions bloom-habit-actions">{!cardTimer && <button aria-describedby={active ? `habit-title-${h.id} timer-state-${active.id}` : `habit-title-${h.id}`} title={active ? `A timer for ${activeHabit?.name ?? "another habit"} is already ${active.status}.` : undefined} className="bloom-primary" disabled={!enabled || Boolean(active)} onClick={() => void command({kind:"start",habit:h.id,request:crypto.randomUUID()})}>Start timer</button>}<button aria-describedby={`habit-title-${h.id}`} disabled={!enabled} onClick={() => openQuick(h.id)}>Quick Log</button><button aria-describedby={`habit-title-${h.id}`} onClick={() => navigate(tab, h.id)}>Details</button></div></li>;
      })}</ul>}</section></>}
      {!detail && tab === "progress" && <section><p className="bloom-kicker">MONDAY–SUNDAY · LAGOS</p><h1>Progress</h1><div className="bloom-actions"><button onClick={() => setWeek(addDays(week,-7))}>Previous week</button><strong>{week} to {addDays(week,6)}</strong><button disabled={week >= weekStart(today)} onClick={() => setWeek(addDays(week,7))}>Next week</button></div><p>{demo ? "Goals below are simulated; changes begin next full Lagos week." : "Goal scheduling is unavailable; no target or achievement is assumed."}</p><ul className="bloom-list">{data.habits.map(h => { let goal: ReturnType<typeof goalForWeek> = {kind:"unconfirmed"}; let unresolved = false; try { if (demo) goal = goalForWeek(data.goals,h.id,week); } catch { unresolved = true; } const report = weeklySummary(data.sessions,h.id,week,goal); return <li className="bloom-panel" key={h.id}><h2 className="bloom-report-habit"><button className="bloom-link" onClick={() => navigate(tab, h.id)}>{h.name}</button>{!h.is_active && " · archived"}</h2><p>{report.sessions} {report.sessions === 1 ? "session" : "sessions"} · {report.activeDays} active {report.activeDays === 1 ? "day" : "days"}</p><p>{unresolved ? "Goal schedule pending; counts remain available." : goal.kind === "target" ? `Weekly target: ${sessionCountLabel(goal.value)}${report.achieved ? " · achieved" : ""}` : goal.kind === "none" ? "No weekly target confirmed" : "Weekly goal not confirmed"}</p><p>Total time invested: {report.measuredMs === null && report.estimatedMs === null ? "none recorded" : duration((report.measuredMs ?? 0) + (report.estimatedMs ?? 0))}</p><p>Measured: {report.measuredMs === null ? "none recorded" : duration(report.measuredMs)} · Estimated: {report.estimatedMs === null ? "none recorded" : duration(report.estimatedMs)} · Unknown duration: {report.unknownDurationSessions}</p></li>; })}</ul>{data.habits.length === 0 && <p>No habits to report yet.</p>}</section>}
      {!detail && tab === "settings" && <section><p className="bloom-kicker">YOUR PREFERENCES</p><h1>Settings</h1><label>Theme <select value={theme} onChange={e => { const value = e.target.value as typeof theme; setTheme(value); try { localStorage.setItem("bloom.local.theme",value); } catch { setMessage("Theme preference could not be saved in this browser."); } }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>{demo && <div className="bloom-panel bloom-form"><h2>Simulated profile</h2><form onSubmit={e => { e.preventDefault(); try { localStorage.setItem("bloom.phase1.profile", profileDraft.trim()); setDemoName(profileDraft.trim()); setProfileDraft(profileDraft.trim()); setSuccess("Simulated profile saved in this browser."); } catch { setMessage("Could not save the simulated profile."); } }}><label>Display name <input maxLength={80} value={profileDraft} onChange={e => setProfileDraft(e.target.value)} /></label><button type="submit">Save profile</button></form><p>This does not update a real account.</p></div>}{demo && <div className="bloom-panel"><h2>Demo data</h2><p>This workspace is simulated and kept only in this browser.</p><button disabled={!enabled} onClick={() => { if (window.confirm("Erase all simulated data in this browser?")) { resetDemo(); setDemoName(""); setProfileDraft(""); sessionStorage.removeItem(pendingKey(userId)); setPending(null); void refresh(); setSuccess("Simulated data cleared."); } }}>Reset simulated data</button></div>}<div className="bloom-panel"><h2>Account deletion</h2><p>Self-service deletion is not available in this local build. No deletion request will be submitted.</p><button disabled>Delete account unavailable</button></div></section>}
      {detail && !selected && <section className="bloom-detail-page bloom-panel" aria-labelledby="detail-title"><div className="bloom-detail-topbar"><button type="button" className="bloom-back-button" onClick={closeDetails}><span aria-hidden="true">←</span> Back to {detailBackLabel}</button><p className="bloom-kicker">HABIT DETAILS · LAGOS</p></div><h1 id="detail-title" tabIndex={-1}>Habit not found</h1><p>This habit is not available in this workspace.</p></section>}
      {detail && selected && <HabitDetailsScreen
        habit={selected}
        backLabel={detailBackLabel}
        demo={demo}
        enabled={enabled}
        currentWeek={detailsWeek}
        goal={detailsGoal}
        goalPending={detailsGoalPending}
        weekSummary={detailsWeekSummary!}
        completedSessionCount={selectedCompletedCount}
        activeDayCount={selectedActiveDayCount}
        measuredMs={selectedMeasuredMs}
        estimatedMs={selectedEstimatedMs}
        unknownDurationCount={selectedUnknownDurationCount}
        history={selectedSessions}
        versions={selectedVersions}
        allVersions={data.versions}
        goalHistory={data.goals.filter(g => g.habit_id === selected.id)}
        scheduledGoals={scheduledGoals}
        hasActiveTimer={Boolean(active)}
        activeTimerId={active?.id ?? null}
        activeTimerStatus={active?.status ?? null}
        activeTimerHabit={activeHabit}
        timer={active && hasDetailsTimer ? <ActiveSessionTimer session={active} habit={activeHabit} elapsed={elapsed} timerError={timerError} enabled={enabled} demo={demo} variant="panel" cancelConfirm={cancelConfirm} warningDismissed={warningDismissedFor === active.id} onToggle={() => void command({kind:active.status === "running" ? "pause" : "resume",session:active.id,request:crypto.randomUUID()})} onComplete={() => void command({kind:"complete",session:active.id,request:crypto.randomUUID()})} onRequestCancel={() => setCancelConfirm(active.id)} onCancel={() => void command({kind:"cancel",session:active.id,request:crypto.randomUUID()})} onKeepTimer={() => setCancelConfirm(null)} onContinue={() => setWarningDismissedFor(active.id)} /> : null}
        archiveConfirm={archiveConfirm === selected.id}
        onBack={closeDetails}
        onStartTimer={() => void command({kind:"start",habit:selected.id,request:crypto.randomUUID()})}
        onQuickLog={() => openQuick(selected.id)}
        onEdit={() => openEdit(selected.id)}
        onSetGoal={() => openGoal(selected.id)}
        onArchive={() => requestArchive(selected.id)}
        onConfirmArchive={() => void archiveHabit(selected.id)}
        onKeepArchive={() => setArchiveConfirm(null)}
      />}
      </>}
      {goalEdit && <GoalForm key={goalEdit} habit={data.habits.find(h => h.id === goalEdit)} disabled={!enabled} onClose={() => closeDraft(() => setGoalEdit(null))} onDirty={() => setDraftDirty(true)} onSubmit={target => void command({kind:"goal",request:crypto.randomUUID(),habit:goalEdit,target})} />}
      {quick && <QuickForm key={quick} habit={data.habits.find(h => h.id === quick)} today={today} disabled={!enabled} onClose={() => closeDraft(() => setQuick(null))} onDirty={() => setDraftDirty(true)} onSubmit={(date, estimatedMs, note) => void command({kind:"quick",request:crypto.randomUUID(),habit:quick,date,estimatedMs,note})} />}
      {edit && <section key={edit} className="bloom-panel bloom-form" aria-labelledby="edit-title"><h2 id="edit-title" tabIndex={-1}>{edit === "new" ? "Create a habit" : "Edit habit"}</h2><form onChange={() => setDraftDirty(true)} onSubmit={event => void saveHabit(event)}><label>Name <input name="name" disabled={!enabled} required maxLength={120} defaultValue={editHabit?.name ?? ""} /></label><label>Description <textarea name="description" disabled={!enabled} maxLength={500} defaultValue={editHabit?.description ?? ""} /></label><label>Preferred time in Lagos <input name="preferred_time" disabled={!enabled} type="time" defaultValue={editHabit?.preferred_time?.slice(0,5) ?? ""} /></label><p>{demo ? "After creating a habit, open its details to confirm a weekly session goal." : "Weekly session goal selection is not available in this local build."}</p><div className="bloom-actions"><button className="bloom-primary" disabled={!enabled} type="submit">Save habit</button><button type="button" onClick={() => closeDraft(() => setEdit(null))}>Cancel</button></div></form></section>}
    </main>
    <nav className="bloom-nav" aria-label="Main navigation">{(["today","progress","settings"] as const).map(t => { const Icon = t === "today" ? CalendarIcon : t === "progress" ? ChartIcon : SettingsIcon; return <button key={t} aria-current={tab === t ? "page" : undefined} onClick={() => navigate(t)}><Icon aria-hidden="true" /><span>{t[0].toUpperCase()+t.slice(1)}</span></button>; })}</nav>
  </div>;
}

type ActiveSessionTimerProps = {
  session: SessionRow;
  habit: Habit | undefined;
  elapsed: number;
  timerError: boolean;
  enabled: boolean;
  demo: boolean;
  variant: "card" | "panel";
  cancelConfirm: string | null;
  warningDismissed: boolean;
  onToggle: () => void;
  onComplete: () => void;
  onRequestCancel: () => void;
  onCancel: () => void;
  onKeepTimer: () => void;
  onContinue: () => void;
};

/** Both placements render the same loaded session; this component owns no timer state or clock. */
function ActiveSessionTimer({ session, habit, elapsed, timerError, enabled, demo, variant, cancelConfirm, warningDismissed, onToggle, onComplete, onRequestCancel, onCancel, onKeepTimer, onContinue }: ActiveSessionTimerProps) {
  const running = session.status === "running";
  const stateId = `timer-state-${session.id}`;
  return <section className={`bloom-timer${variant === "card" ? " bloom-card-timer" : ""}`} aria-label={`Current timer for ${habit?.name ?? "habit"}`}>
    <div className="bloom-timer-heading">
      <div className="bloom-timer-copy">
        <p id={stateId} className="bloom-kicker">YOUR TIMER · {session.status.toUpperCase()}</p>
        <p className={`bloom-timer-state${running ? " is-running" : " is-paused"}`}><span className="bloom-timer-indicator" aria-hidden="true" />{running ? "Timer running" : "Timer paused"}</p>
        {variant === "panel" && <h2>{habit?.name ?? "Habit"}{habit && !habit.is_active ? " · archived" : ""}</h2>}
      </div>
      {timerError ? <p role="alert">Timer state is inconsistent. Refresh before taking action.</p> : <p className="bloom-clock" role="timer" aria-live="off" aria-label={`Elapsed time ${duration(elapsed)}`}>{duration(elapsed)}</p>}
    </div>
    <p className="bloom-timer-note">{demo ? "Simulated timer: this browser’s clock records the time." : "Elapsed display is an estimate. The server records the final time."}</p>
    {elapsed >= FOUR_HOURS_MS && !warningDismissed && <div className="bloom-warning" role="status">This timer has run for four hours or more. It will keep running until you pause, complete or cancel it. <button type="button" onClick={onContinue}>Continue timer</button></div>}
    <div className="bloom-actions bloom-timer-actions"><button type="button" disabled={!enabled || timerError} onClick={onToggle}>{running ? "Pause" : "Resume"}</button><button type="button" className="bloom-primary" disabled={!enabled || timerError} onClick={onComplete}>Complete</button><button type="button" className="bloom-timer-cancel" disabled={!enabled} onClick={onRequestCancel}>Cancel timer</button></div>
    {cancelConfirm === session.id && <div className="bloom-confirm bloom-cancel-confirm" role="group" aria-labelledby={`cancel-prompt-${session.id}`}><p id={`cancel-prompt-${session.id}`} role="alert">Cancel this timer without recording a completed session?</p><button type="button" className="bloom-timer-cancel" disabled={!enabled} onClick={onCancel}>Yes, cancel timer</button> <button type="button" onClick={onKeepTimer}>Keep timer</button></div>}
  </section>;
}

type HabitDetailsScreenProps = {
  habit: Habit;
  backLabel: string;
  demo: boolean;
  enabled: boolean;
  currentWeek: string;
  goal: ReturnType<typeof goalForWeek>;
  goalPending: boolean;
  weekSummary: ReturnType<typeof weeklySummary>;
  completedSessionCount: number;
  activeDayCount: number;
  measuredMs: number | null;
  estimatedMs: number | null;
  unknownDurationCount: number;
  history: SessionRow[];
  versions: VersionRow[];
  allVersions: VersionRow[];
  goalHistory: DemoGoal[];
  scheduledGoals: DemoGoal[];
  hasActiveTimer: boolean;
  activeTimerId: string | null;
  activeTimerStatus: SessionRow["status"] | null;
  activeTimerHabit: Habit | undefined;
  timer: ReactNode;
  archiveConfirm: boolean;
  onBack: () => void;
  onStartTimer: () => void;
  onQuickLog: () => void;
  onEdit: () => void;
  onSetGoal: () => void;
  onArchive: () => void;
  onConfirmArchive: () => void;
  onKeepArchive: () => void;
};

function HabitDetailsScreen({ habit, backLabel, demo, enabled, currentWeek, goal, goalPending, weekSummary, completedSessionCount, activeDayCount, measuredMs, estimatedMs, unknownDurationCount, history, versions, allVersions, goalHistory, scheduledGoals, hasActiveTimer, activeTimerId, activeTimerStatus, activeTimerHabit, timer, archiveConfirm, onBack, onStartTimer, onQuickLog, onEdit, onSetGoal, onArchive, onConfirmArchive, onKeepArchive }: HabitDetailsScreenProps) {
  const hasKnownTime = measuredMs !== null || estimatedMs !== null;
  const targetProgress = goal.kind === "target" && !goalPending ? Math.min(goal.value, weekSummary.sessions) : 0;
  const progressPercent = goal.kind === "target" && !goalPending ? Math.min(100, Math.round(weekSummary.sessions * 100 / goal.value)) : 0;
  const startReason = hasActiveTimer
    ? `A timer for ${activeTimerHabit?.name ?? "another habit"} is already ${activeTimerStatus ?? "active"}. Complete or cancel it before starting another.`
    : !habit.is_active ? "Archived habits cannot start a new timer." : undefined;
  return <section className="bloom-detail-page" aria-labelledby="detail-title">
    <div className="bloom-detail-topbar"><button type="button" className="bloom-back-button" onClick={onBack}><span aria-hidden="true">←</span> Back to {backLabel}</button><span className="bloom-kicker">HABIT DETAILS · LAGOS</span></div>
    <header className="bloom-detail-hero">
      <p className="bloom-kicker">{habit.is_active ? "ACTIVE HABIT" : "ARCHIVED HABIT"}</p>
      <h1 id="detail-title" tabIndex={-1}>{habit.name}</h1>
      <p className="bloom-detail-description">{habit.description || "No description added yet."}</p>
      <p className="bloom-detail-meta">Preferred time: {habit.preferred_time?.slice(0,5) ?? "not set"} · {demo ? "Goals and session timestamps are simulated" : "Weekly goal scheduling unavailable in this local adapter"}</p>
    </header>
    {timer}
    <div className="bloom-detail-main-grid">
      <section className="bloom-panel bloom-detail-goal" aria-labelledby="detail-goal-title">
        <p className="bloom-kicker">LAGOS WEEK · {currentWeek}–{addDays(currentWeek,6)}</p>
        <h2 id="detail-goal-title">Weekly session goal</h2>
        {!demo && <p>Goal scheduling is unavailable here; no target is assumed. Weekly counts remain available.</p>}
        {demo && goalPending && <p role="status">Goal schedule pending; completed-session counts remain available.</p>}
        {demo && !goalPending && goal.kind === "target" && <>
          <p>Weekly target: {goal.value} completed {goal.value === 1 ? "session" : "sessions"}.</p>
          <div className="bloom-detail-progress-heading"><span>Current progress</span><strong>{weekSummary.sessions} / {goal.value} {goal.value === 1 ? "session" : "sessions"}</strong></div>
          <div className="bloom-progress-track bloom-detail-progress-track" role="progressbar" aria-label={`Weekly session goal for ${habit.name}`} aria-valuemin={0} aria-valuemax={goal.value} aria-valuenow={targetProgress} aria-valuetext={`${targetProgress} of ${goal.value} ${goal.value === 1 ? "session" : "sessions"} completed`}><span style={{width:`${progressPercent}%`}} /></div>
        </>}
        {demo && !goalPending && goal.kind === "none" && <p>No weekly target confirmed.</p>}
        {demo && !goalPending && goal.kind === "unconfirmed" && <p>Weekly goal not confirmed.</p>}
        <p className="bloom-detail-week-count">This week: {weekSummary.sessions} completed {weekSummary.sessions === 1 ? "session" : "sessions"} · {weekSummary.activeDays} active {weekSummary.activeDays === 1 ? "day" : "days"}.</p>
        {demo && scheduledGoals.length > 0 && <p className="bloom-detail-scheduled">Next confirmed change: from {scheduledGoals[0].effective_week}, {scheduledGoals[0].weekly_session_target === null ? "No weekly target" : `${sessionCountLabel(scheduledGoals[0].weekly_session_target)} per week`}.</p>}
        {demo && habit.is_active && <button type="button" disabled={!enabled} onClick={onSetGoal}>Set weekly session goal</button>}
      </section>
      <section className="bloom-panel bloom-detail-actions-panel" aria-labelledby="detail-actions-title">
        <p className="bloom-kicker">YOUR NEXT STEP</p>
        <h2 id="detail-actions-title">Habit actions</h2>
        {hasActiveTimer && <p id="detail-active-timer-note">A {activeTimerStatus ?? "active"} timer is already in progress{activeTimerHabit?.name ? ` for ${activeTimerHabit.name}` : ""}. Use its controls above; a second timer is blocked.</p>}
        <div className="bloom-actions bloom-detail-actions">
          <button type="button" className="bloom-primary" aria-describedby={hasActiveTimer && activeTimerId ? `timer-state-${activeTimerId}` : undefined} title={startReason} disabled={!enabled || !habit.is_active || hasActiveTimer} onClick={onStartTimer}>Start Timer</button>
          <button type="button" disabled={!enabled || !habit.is_active} onClick={onQuickLog}>Quick Log</button>
          {habit.is_active && <button type="button" disabled={!enabled} onClick={onEdit}>Edit Habit</button>}
          {habit.is_active && <button type="button" className="bloom-secondary" disabled={!enabled} onClick={onArchive}>Archive Habit</button>}
        </div>
        {!habit.is_active && <p>This habit is archived. It can no longer start new sessions; its history is preserved.</p>}
        {archiveConfirm && <div className="bloom-confirm bloom-detail-archive-confirm" role="group" aria-labelledby={`archive-prompt-${habit.id}`}><p id={`archive-prompt-${habit.id}`} role="alert">Archive {habit.name}? Its history remains, and an existing timer may still be completed or cancelled.</p><button type="button" className="bloom-secondary" disabled={!enabled} onClick={onConfirmArchive}>Yes, archive habit</button><button type="button" onClick={onKeepArchive}>Keep habit</button></div>}
      </section>
    </div>
    <section className="bloom-detail-summary" aria-labelledby="detail-summary-title">
      <div className="bloom-section-heading"><div><p className="bloom-kicker">ALL-TIME OVERVIEW</p><h2 id="detail-summary-title">Your progress</h2></div></div>
      <div className="bloom-detail-summary-grid">
        <article className="bloom-panel bloom-detail-stat"><span>Completed sessions</span><strong>{completedSessionCount}</strong><small>All time · cancelled sessions excluded</small></article>
        <article className="bloom-panel bloom-detail-stat"><span>Active days</span><strong>{activeDayCount}</strong><small>Distinct Lagos completion dates</small></article>
        <article className="bloom-panel bloom-detail-stat bloom-detail-time-stat"><span>Total time invested</span><strong>{hasKnownTime ? duration((measuredMs ?? 0) + (estimatedMs ?? 0)) : "none recorded"}</strong><small>Measured: {measuredMs === null ? "none recorded" : duration(measuredMs)} · Estimated: {estimatedMs === null ? "none recorded" : duration(estimatedMs)} · Unknown duration: {unknownDurationCount}</small></article>
      </div>
    </section>
    <section className="bloom-panel bloom-detail-history" aria-labelledby="detail-history-title">
      <div className="bloom-actions bloom-spread"><div><p className="bloom-kicker">YOUR JOURNEY</p><h2 id="detail-history-title">Session history</h2></div><span>{completedSessionCount} completed</span></div>
      {!history.length ? <p>No completed sessions yet.</p> : <ol className="bloom-history">{history.map(session => <li key={session.id}><strong>{session.completed_on ?? "Completion date unavailable"}</strong> · {session.source === "legacy" ? "Imported" : session.source === "quick" ? "Quick Log" : "Timed"} · {session.duration_ms !== null ? `${duration(session.duration_ms)} measured` : session.estimated_ms !== null ? `${duration(session.estimated_ms)} estimated` : "duration unknown"}<p>Recorded {new Date(session.created_at).toLocaleString("en-GB",{timeZone:"Africa/Lagos"})} Lagos{allVersions.find(v => v.id === session.completion_version_id) ? ` · known name: ${allVersions.find(v => v.id === session.completion_version_id)!.name}` : ""}</p>{session.note && <p>{session.note}</p>}</li>)}</ol>}
    </section>
    {demo && <details className="bloom-panel bloom-detail-history-details"><summary>Simulated goal history</summary>{goalHistory.length ? <ol className="bloom-history">{goalHistory.slice().reverse().map(g => <li key={g.id}>From {g.effective_week ?? "pending"}: {g.weekly_session_target === null ? "No weekly target" : `${sessionCountLabel(g.weekly_session_target)} per week`}</li>)}</ol> : <p>No session goal has been confirmed.</p>}</details>}
    <details className="bloom-panel bloom-detail-history-details"><summary>Known habit settings history</summary><p>Only versions recorded since history was enabled are available; earlier changes are unknown.</p>{versions.length ? <ol className="bloom-history">{versions.map(version => <li key={version.id}><strong>{new Date(version.recorded_at).toLocaleString("en-GB",{timeZone:"Africa/Lagos"})} Lagos</strong> · {version.is_baseline ? "baseline · " : ""}{version.name} · {version.is_active ? "active" : "archived"} · preferred time {version.preferred_time?.slice(0,5) ?? "not set"}{version.description && <p>{version.description}</p>}<p>Legacy schedule: {version.frequency}{version.target_per_week === null ? "" : `, ${version.target_per_week} days per week`}. This is not a session goal.</p></li>)}</ol> : <p>No settings history available.</p>}</details>
  </section>;
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
