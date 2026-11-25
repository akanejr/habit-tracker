"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { LogoutButton } from "@/components/auth/logout-button";
import { createClient } from "@/lib/supabase/client";
import { friendlyDate, greeting, lagosDate, weekStart } from "@/lib/habits/dates";
import { countThisWeek, dailyProgress, todayHabits, type Habit, type HabitLog } from "@/lib/habits/progress";
import { HabitForm, type HabitInput } from "./habit-form";
import { ArchiveIcon, CalendarIcon, ChartIcon, CheckIcon, CloseIcon, EditIcon, PlusIcon, SettingsIcon, SproutIcon } from "./icons";

type Editor = { mode: "add" } | { mode: "edit"; habit: Habit } | null;

function displayTime(time: string | null) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function TodayDashboard({ userId, displayName }: { userId: string; displayName: string | null }) {
  const [day, setDay] = useState(() => lagosDate());
  const [habits, setHabits] = useState<Habit[]>([]);
  const [logs, setLogs] = useState<HabitLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [manage, setManage] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);

  const load = useCallback(async () => {
    const today = lagosDate();
    try {
      const supabase = createClient();
      const [habitResult, logResult] = await Promise.all([
        supabase.from("habits").select("*").eq("user_id", userId).eq("is_active", true).order("created_at", { ascending: true }),
        supabase.from("habit_logs").select("*").eq("user_id", userId).gte("completed_on", weekStart(today)).lte("completed_on", today),
      ]);
      if (habitResult.error || logResult.error) throw new Error("Unable to load");
      setLoadError(""); setHabits(habitResult.data); setLogs(logResult.data); setDay(today);
    } catch { setLoadError("We couldn’t load your habits. Check your connection or log in again, then try once more."); }
    finally { setLoading(false); }
  }, [userId]);

  // Fetching the signed-in user's hosted data is an external-system effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (lagosDate() !== day) { setLoading(true); void load(); } }, 30000);
    const onFocus = () => { if (lagosDate() !== day) { setLoading(true); void load(); } };
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [day, load]);

  const start = weekStart(day);
  const todays = useMemo(() => todayHabits(habits, logs, start, day), [habits, logs, start, day]);
  const progress = dailyProgress(todays, logs, day);
  const firstName = displayName?.trim().split(/\s+/)[0] || "friend";

  async function toggle(habit: Habit) {
    if (pending.includes(habit.id)) return;
    if (lagosDate() !== day) { setActionError("It’s a new day in Lagos. Your habits are being refreshed."); setLoading(true); await load(); return; }
    const existing = logs.find(log => log.habit_id === habit.id && log.completed_on === day);
    if (!existing && habit.frequency === "weekly" && countThisWeek(logs, habit.id, start, day) >= (habit.target_per_week ?? 0)) return;
    const tempId = `pending-${habit.id}`;
    const optimistic: HabitLog = { id: tempId, habit_id: habit.id, user_id: userId, completed_on: day, note: null, created_at: new Date().toISOString() };
    setActionError(""); setPending(previous => [...previous, habit.id]);
    setLogs(previous => existing ? previous.filter(log => log.id !== existing.id) : [...previous, optimistic]);
    try {
      const supabase = createClient();
      if (existing) {
        const { error } = await supabase.from("habit_logs").delete().eq("id", existing.id).eq("user_id", userId).eq("habit_id", habit.id).eq("completed_on", day);
        if (error) throw error;
      } else {
        // Refresh weekly count before recording, in case another tab completed it.
        if (habit.frequency === "weekly") {
          const { count, error } = await supabase.from("habit_logs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("habit_id", habit.id).gte("completed_on", start).lte("completed_on", day);
          if (error) throw error;
          if ((count ?? 0) >= (habit.target_per_week ?? 0)) { await load(); return; }
        }
        const { data, error } = await supabase.from("habit_logs").insert({ habit_id: habit.id, user_id: userId, completed_on: day }).select().single();
        if (error) throw error;
        setLogs(previous => previous.map(log => log.id === tempId ? data : log));
      }
    } catch {
      setLogs(previous => existing ? (previous.some(log => log.id === existing.id) ? previous : [...previous, existing]) : previous.filter(log => log.id !== tempId));
      setActionError("We couldn’t save that change. Please check your connection and try again.");
    } finally { setPending(previous => previous.filter(id => id !== habit.id)); }
  }

  async function saveHabit(values: HabitInput) {
    if (!editor || saving) return;
    setSaving(true); setFormError("");
    try {
      const supabase = createClient();
      if (editor.mode === "edit") {
        const { data, error } = await supabase.from("habits").update(values).eq("id", editor.habit.id).eq("user_id", userId).eq("is_active", true).select().single();
        if (error) throw error;
        setHabits(previous => previous.map(h => h.id === data.id ? data : h));
      } else {
        const { data, error } = await supabase.from("habits").insert({ ...values, user_id: userId }).select().single();
        if (error) throw error;
        setHabits(previous => [...previous, data]);
      }
      setEditor(null); setActionError("");
    } catch { setFormError("We couldn’t save your habit. Check your connection and try again."); }
    finally { setSaving(false); }
  }

  async function archive(habit: Habit) {
    if (archiving) return;
    setArchiving(habit.id); setActionError("");
    try {
      // Archive only: never delete a habit or its historical completion records.
      const { data, error } = await createClient().from("habits").update({ is_active: false }).eq("id", habit.id).eq("user_id", userId).eq("is_active", true).select("id").single();
      if (error || !data) throw error || new Error("No habit updated");
      setHabits(previous => previous.filter(item => item.id !== habit.id));
      setConfirmArchive(null);
    } catch { setActionError("We couldn’t archive that habit. Please try again."); }
    finally { setArchiving(null); }
  }

  function openAdd() { setFormError(""); setEditor({ mode: "add" }); }
  function openEdit(habit: Habit) { setFormError(""); setEditor({ mode: "edit", habit }); }
  return <div className="today-app">
    <header className="today-header"><Brand /><div className="today-header-right"><span className="header-date"><CalendarIcon /> {friendlyDate(day)}</span><Link href="/account" className="header-link">Account</Link><LogoutButton /></div></header>
    <main className="today-main">
      <div className="today-title-row"><div><p className="dash-eyebrow"><span className="dash-green-dot" /> YOUR SPACE TO GROW</p><h1>{greeting()}, <em>{firstName}.</em></h1><p className="today-subtitle">A little progress, every day. You’ve got this.</p></div><button className="button add-header" onClick={openAdd}><PlusIcon /> Add habit</button></div>
      <div className="today-date"><CalendarIcon /><span>{friendlyDate(day)}</span><span className="date-timezone">LAGOS TIME</span></div>
      {actionError && <div className="notice notice-error dash-alert" role="alert">{actionError} <button type="button" onClick={() => setActionError("")} aria-label="Dismiss">×</button></div>}
      {loading ? <div className="dashboard-loading" role="status"><div className="loading-line"/><div className="loading-line short"/><p>Making space for today…</p></div> : loadError ? <div className="dashboard-empty" role="alert"><div className="empty-symbol">!</div><h2>Let’s try that again.</h2><p>{loadError}</p><button className="button button-primary" onClick={() => { setLoading(true); void load(); }}>Try again →</button></div> : <>
        <section className="progress-card" aria-labelledby="progress-title"><div className="progress-top"><div><p className="progress-eyebrow">A LITTLE GOES A LONG WAY</p><h2 id="progress-title">Your daily progress</h2><p>{progress.total === 0 ? "No habits scheduled for today yet." : progress.completed === progress.total ? "A lovely day’s work. You showed up for yourself." : "Every little step is worth celebrating."}</p></div><div className="progress-symbol"><SproutIcon /></div></div><div className="progress-label"><span>{progress.completed} <span className="progress-muted">/ {progress.total} completed</span></span><strong>{progress.percentage}%</strong></div><div className="progress-track" role="progressbar" aria-label="Today's progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage}><span style={{width:`${progress.percentage}%`}} /></div><div className="progress-footer"><span>{progress.total === 0 ? "YOUR NEXT STEP STARTS HERE" : "ONE DAY AT A TIME"}</span><span>✳</span></div></section>
        <section className="habits-section" aria-labelledby="today-habits-title"><div className="section-header"><div><p className="dash-eyebrow">A MOMENT FOR YOU</p><h2 id="today-habits-title">Today’s habits <span>{todays.length}</span></h2></div><button type="button" className="manage-link" onClick={() => setManage(!manage)} aria-expanded={manage}>{manage ? "Done managing" : "Manage habits"} <span aria-hidden="true">↗</span></button></div>
          {manage && <div className="manage-panel"><div className="manage-heading"><div><strong>All active habits</strong><p>Archived habits keep their history.</p></div><button className="icon-button" aria-label="Close manage habits" onClick={() => { setManage(false); setConfirmArchive(null); }}><CloseIcon /></button></div>{habits.length === 0 ? <p className="manage-empty">No active habits yet.</p> : <ul className="manage-list">{habits.map(habit => <li key={habit.id}><div className="manage-name"><span className="color-dot" style={{backgroundColor: habit.color || "#668768"}}/><span><strong>{habit.name}</strong><small>{habit.frequency === "weekly" ? `${habit.target_per_week ?? "—"} days a week` : habit.frequency === "daily" ? "Every day" : "Custom schedule"}</small></span></div><div className="manage-actions"><button className="icon-button" aria-label={`Edit ${habit.name}`} disabled={habit.frequency === "custom" || Boolean(archiving) || pending.includes(habit.id)} title={habit.frequency === "custom" ? "Custom schedules aren’t supported in this milestone" : "Edit"} onClick={() => openEdit(habit)}><EditIcon /></button><button className="icon-button" aria-label={`Archive ${habit.name}`} disabled={Boolean(archiving) || pending.includes(habit.id)} onClick={() => setConfirmArchive(habit.id)}><ArchiveIcon /></button></div>{confirmArchive === habit.id && <div className="archive-confirm"><p>Archive this habit? Your past completions will stay safe.</p><button className="plain-button" disabled={Boolean(archiving)} onClick={() => setConfirmArchive(null)}>Cancel</button><button className="archive-button" disabled={Boolean(archiving)} onClick={() => void archive(habit)}>{archiving === habit.id ? "Archiving…" : "Yes, archive"}</button></div>}</li>)}</ul>}{habits.some(h => h.frequency === "custom") && <p className="form-note">Custom schedules can be archived but not edited in this milestone.</p>}</div>}
          {todays.length === 0 ? <div className="dashboard-empty"><div className="empty-symbol"><SproutIcon /></div><h2>{habits.length ? "A little breathing room." : "Let’s start small."}</h2><p>{habits.length ? "There are no habits scheduled for today. Your weekly goals may already be complete." : "The best routines begin with one small step. Add a habit that matters to you."}</p><button className="button button-primary" onClick={openAdd}><PlusIcon /> {habits.length ? "Add a habit" : "Add your first habit"}</button></div> : <ul className="habit-list">{todays.map(habit => {
            const done = logs.some(log => log.habit_id === habit.id && log.completed_on === day);
            const count = countThisWeek(logs, habit.id, start, day);
            const itemPending = pending.includes(habit.id);
            return <li className={`habit-item${done ? " is-done" : ""}`} key={habit.id}><span className="habit-accent" style={{"--habit-color": habit.color || "#668768"} as React.CSSProperties}><SproutIcon /></span><div className="habit-copy"><strong>{habit.name}</strong><span>{habit.frequency === "weekly" ? `${count} of ${habit.target_per_week} this week` : "Every day"}{habit.preferred_time ? `  ·  ${displayTime(habit.preferred_time)}` : ""}</span>{habit.description && <small>{habit.description}</small>}</div><button type="button" className={`habit-check${done ? " checked" : ""}`} disabled={itemPending || archiving === habit.id} onClick={() => void toggle(habit)} aria-label={done ? `Undo completion of ${habit.name}` : `Mark ${habit.name} complete`} aria-pressed={done}>{done && <CheckIcon />}</button></li>;
          })}</ul>}
        </section><div className="gentle-note"><span>✳</span><p><strong>Be kind to yourself.</strong> Consistency is a practice, not perfection.</p></div>
      </>}
    </main>
    <nav className="bottom-nav" aria-label="Main navigation"><div className="bottom-nav-inner"><span className="nav-tab active" aria-current="page"><CalendarIcon /><span>Today</span></span><span className="nav-tab muted" aria-label="Progress, coming soon"><ChartIcon /><span>Progress <small>SOON</small></span></span><span className="nav-tab muted" aria-label="Settings, coming soon"><SettingsIcon /><span>Settings <small>SOON</small></span></span></div></nav>
    {editor && <HabitForm key={editor.mode === "edit" ? editor.habit.id : "new"} habit={editor.mode === "edit" ? editor.habit : null} busy={saving} error={formError} onClose={() => { if (!saving) setEditor(null); }} onSave={value => void saveHabit(value)} />}
  </div>;
}
