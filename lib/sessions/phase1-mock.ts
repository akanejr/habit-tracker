/** Browser-only UX sandbox. No Supabase calls, server clock, real user data or concurrency guarantees. */
import type { Command, Habit, SessionRow, SegmentRow, VersionRow } from './client';
import type { GoalVersion } from './core';
import { addDays, timerDisplayMs } from './core';
import { lagosDate, weekStart } from '../habits/dates';

export type DemoGoal = GoalVersion & { recorded_at: string };
export type DemoWorkspace = { habits: Habit[]; sessions: SessionRow[]; segments: SegmentRow[]; versions: VersionRow[]; goals: DemoGoal[] };
type State = DemoWorkspace & { receipts: Record<string, string> };
const KEY = 'bloom.phase1.mock.v1';
const USER = 'phase1-synthetic-user';
const blank = (): State => ({ habits: [], sessions: [], segments: [], versions: [], goals: [], receipts: {} });
function read(): State { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) as State : blank(); }
function save(s: State) { localStorage.setItem(KEY, JSON.stringify(s)); }
export async function loadDemo(): Promise<DemoWorkspace> {
  const { habits, sessions, segments, versions, goals } = read();
  return { habits, sessions, segments, versions, goals };
}
export function resetDemo() { localStorage.removeItem(KEY); localStorage.removeItem("bloom.phase1.profile"); }
export async function executeDemo(command: Command): Promise<void> {
  const s = read();
  const payload = JSON.stringify(command);
  if (s.receipts[command.request]) {
    if (s.receipts[command.request] !== payload) throw new Error('Request ID reused');
    return;
  }
  const now = new Date(), timestamp = now.toISOString(), today = lagosDate(now);
  const getHabit = (id: string) => { const h = s.habits.find(h => h.id === id); if (!h) throw new Error('Habit not found'); return h; };
  const version = (h: Habit, baseline = false) => { s.versions.push({ id: s.versions.length + 1, habit_id: h.id, user_id: USER, recorded_at: timestamp, is_baseline: baseline, name: h.name, description: h.description, frequency: h.frequency, target_per_week: h.target_per_week, preferred_time: h.preferred_time, color: h.color, icon: h.icon, is_active: h.is_active }); };
  if (command.kind === 'habit_create') {
    const h: Habit = { id: crypto.randomUUID(), user_id: USER, name: command.name, description: command.description, preferred_time: command.time, frequency: 'daily', target_per_week: null, color: null, icon: null, is_active: true, created_at: timestamp, updated_at: timestamp };
    s.habits.push(h); version(h, true);
  } else if (command.kind === 'habit_update') {
    const h = getHabit(command.habit); if (!h.is_active) throw new Error('Archived habit');
    Object.assign(h, { name: command.name, description: command.description, preferred_time: command.time, updated_at: timestamp }); version(h);
  } else if (command.kind === 'habit_archive') {
    const h = getHabit(command.habit); if (!h.is_active) throw new Error('Already archived'); h.is_active = false; h.updated_at = timestamp; version(h);
  } else if (command.kind === 'goal') {
    const h = getHabit(command.habit); if (!h.is_active) throw new Error('Archived habit');
    if (command.target !== null && (!Number.isSafeInteger(command.target) || command.target < 1)) throw new Error('Invalid target');
    s.goals.push({ id: s.goals.length + 1, habit_id: h.id, effective_week: addDays(weekStart(today), 7), goal_confirmed: true, weekly_session_target: command.target, recorded_at: timestamp });
  } else if (command.kind === 'start' || command.kind === 'quick') {
    const h = getHabit(command.habit); if (!h.is_active) throw new Error('Archived habit');
    if (command.kind === 'start' && s.sessions.some(x => x.source === 'timed' && (x.status === 'running' || x.status === 'paused'))) throw new Error('Timer already active');
    if (command.kind === 'quick' && (command.date > today || addDays(command.date, 0) !== command.date)) throw new Error('Invalid date');
    const id = crypto.randomUUID(), quick = command.kind === 'quick';
    const row: SessionRow = { id, user_id: USER, habit_id: h.id, source: quick ? 'quick' : 'timed', status: quick ? 'completed' : 'running', created_at: timestamp, started_at: quick ? null : timestamp, completed_at: quick ? timestamp : null, recording_mode: quick ? 'quick' : 'timer', completed_on: quick ? command.date : null, duration_ms: null, estimated_ms: quick ? command.estimatedMs : null, note: quick ? command.note : null, start_version_id: quick ? null : (s.versions.filter(v => v.habit_id === h.id).at(-1)?.id ?? null), completion_version_id: quick ? (s.versions.filter(v => v.habit_id === h.id).at(-1)?.id ?? null) : null, legacy_log_id: null };
    s.sessions.push(row);
    if (!quick) s.segments.push({ id: s.segments.length + 1, session_id: id, user_id: USER, started_at: timestamp, ended_at: null });
  } else {
    const session = s.sessions.find(x => x.id === command.session);
    if (!session || !['running', 'paused'].includes(session.status)) throw new Error('Timer not active');
    if (command.kind === 'pause' && session.status !== 'running') throw new Error('Not running');
    if (command.kind === 'resume' && session.status !== 'paused') throw new Error('Not paused');
    const elapsed = timerDisplayMs(session, s.segments, now.getTime());
    if (session.status === 'running') { const open = s.segments.find(x => x.session_id === session.id && x.ended_at === null); if (!open) throw new Error('Missing segment'); open.ended_at = timestamp; }
    if (command.kind === 'resume') { session.status = 'running'; s.segments.push({ id: s.segments.length + 1, session_id: session.id, user_id: USER, started_at: timestamp, ended_at: null }); }
    if (command.kind === 'pause') session.status = 'paused';
    if (command.kind === 'cancel') session.status = 'cancelled';
    if (command.kind === 'complete') { session.status = 'completed'; session.completed_at = timestamp; session.completed_on = today; session.duration_ms = elapsed; session.completion_version_id = s.versions.filter(v => v.habit_id === session.habit_id).at(-1)?.id ?? null; }
  }
  s.receipts[command.request] = payload;
  save(s);
}
