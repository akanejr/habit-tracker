/** Pure calculations for canonical, server-persisted Bloom sessions. */
export type SessionState = "running" | "paused" | "completed" | "cancelled";
export type SessionSource = "timed" | "quick" | "legacy";
export type Session = {
  id: string;
  habit_id: string;
  status: SessionState;
  source: SessionSource;
  completed_on: string | null;
  duration_ms: number | null;
  estimated_ms: number | null;
};
export type Segment = { session_id: string; started_at: string; ended_at: string | null };
export type GoalVersion = {
  id: string | number;
  habit_id: string;
  effective_week: string | null;
  goal_confirmed: boolean;
  weekly_session_target: number | null;
};
export type Goal =
  | { kind: "unconfirmed" }
  | { kind: "none" }
  | { kind: "target"; value: number };

/** Strict calendar date, independent of the browser timezone. */
export function addDays(day: string, amount: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(amount)) throw new Error("Invalid calendar date");
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new Error("Invalid calendar date");
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function nextWeek(monday: string): string {
  addDays(monday, 0);
  if (new Date(`${monday}T00:00:00.000Z`).getUTCDay() !== 1) throw new Error("Week must start on Monday");
  return addDays(monday, 7);
}

/** A target can be scheduled, so only versions effective by the requested week apply. */
export function goalForWeek(versions: readonly GoalVersion[], habitId: string, monday: string): Goal {
  nextWeek(monday);
  let latest: GoalVersion | undefined;
  for (const version of versions) {
    if (version.habit_id !== habitId) continue;
    if (version.effective_week === null) throw new Error("Goal schedule is not resolved");
    if (version.effective_week > monday) continue;
    nextWeek(version.effective_week);
    if (typeof version.id === "number" && !Number.isSafeInteger(version.id)) throw new Error("Unsafe goal version ID");
    if (!latest || version.effective_week > latest.effective_week! ||
      (version.effective_week === latest.effective_week && BigInt(version.id) > BigInt(latest.id))) latest = version;
  }
  if (!latest || !latest.goal_confirmed) return { kind: "unconfirmed" };
  if (latest.weekly_session_target === null) return { kind: "none" };
  if (!Number.isSafeInteger(latest.weekly_session_target) || latest.weekly_session_target < 1) throw new Error("Invalid weekly target");
  return { kind: "target", value: latest.weekly_session_target };
}

export type WeeklySummary = {
  sessions: number;
  activeDays: number;
  measuredMs: number | null;
  estimatedMs: number | null;
  unknownDurationSessions: number;
  goal: Goal;
  achieved: boolean | null;
};

/** Only completed canonical sessions in [Monday, next Monday) count; duplicate IDs count once. */
export function weeklySummary(sessions: readonly Session[], habitId: string, monday: string, goal: Goal): WeeklySummary {
  const end = nextWeek(monday);
  const seen = new Set<string>();
  const days = new Set<string>();
  let completed = 0, measured: number | null = null, estimated: number | null = null, unknown = 0;
  for (const session of sessions) {
    if (session.habit_id !== habitId || session.status !== "completed" || !session.completed_on ||
      session.completed_on < monday || session.completed_on >= end || seen.has(session.id)) continue;
    addDays(session.completed_on, 0);
    seen.add(session.id);
    completed++;
    days.add(session.completed_on);
    for (const duration of [session.duration_ms, session.estimated_ms]) {
      if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0)) throw new Error("Invalid duration");
    }
    if (session.duration_ms !== null && session.estimated_ms !== null) throw new Error("Ambiguous duration");
    if (session.duration_ms !== null) measured = (measured ?? 0) + session.duration_ms;
    else if (session.estimated_ms !== null) estimated = (estimated ?? 0) + session.estimated_ms;
    else unknown++;
    if ((measured !== null && !Number.isSafeInteger(measured)) || (estimated !== null && !Number.isSafeInteger(estimated))) throw new Error("Duration total is too large");
  }
  return { sessions: completed, activeDays: days.size, measuredMs: measured, estimatedMs: estimated,
    unknownDurationSessions: unknown, goal, achieved: goal.kind === "target" ? completed >= goal.value : null };
}

/** Daily progress counts distinct visible habits, not sessions. */
export function dailyHabitProgress(habitIds: readonly string[], sessions: readonly Session[], day: string) {
  addDays(day, 0);
  const visible = new Set(habitIds);
  const completed = new Set(sessions.filter(s => s.status === "completed" && s.completed_on === day && visible.has(s.habit_id)).map(s => s.habit_id));
  return { completed: completed.size, total: visible.size,
    percentage: visible.size ? Math.round(completed.size * 100 / visible.size) : 0 };
}

/** Display interpolation only. Persisted completion duration must always come from the server. */
export function timerDisplayMs(session: Pick<Session, "id" | "status" | "duration_ms">, segments: readonly Segment[], nowMs: number): number {
  if (!Number.isFinite(nowMs)) throw new Error("Invalid display clock");
  if (session.status === "completed") return session.duration_ms ?? 0;
  if (session.status === "cancelled") return 0;
  let elapsed = 0, open = 0;
  for (const segment of segments) {
    if (segment.session_id !== session.id) continue;
    const start = Date.parse(segment.started_at);
    const end = segment.ended_at === null ? nowMs : Date.parse(segment.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || (segment.ended_at !== null && end < start)) throw new Error("Invalid timer segment");
    if (segment.ended_at === null) open++;
    elapsed += Math.max(0, end - start);
  }
  if (open > 1 || (session.status === "running" && open !== 1) || (session.status === "paused" && open !== 0)) throw new Error("Inconsistent timer state");
  return elapsed;
}
export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
