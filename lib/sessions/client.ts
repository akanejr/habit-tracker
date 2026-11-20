import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/types/database";

type Client = ReturnType<typeof createClient>;
export type Habit = Database["public"]["Tables"]["habits"]["Row"];
export type SessionRow = Database["public"]["Tables"]["habit_sessions"]["Row"];
export type VersionRow = Database["public"]["Tables"]["habit_versions"]["Row"];
export type SegmentRow = Database["public"]["Tables"]["habit_session_segments"]["Row"];
export type Command =
  | { kind: "habit_create"; request: string; name: string; description: string | null; time: string | null }
  | { kind: "habit_update"; request: string; habit: string; name: string; description: string | null; time: string | null }
  | { kind: "habit_archive"; request: string; habit: string }
  | { kind: "goal"; request: string; habit: string; target: number | null }
  | { kind: "start"; request: string; habit: string }
  | { kind: "quick"; request: string; habit: string; date: string; estimatedMs: number | null; note: string | null }
  | { kind: "pause" | "resume" | "complete" | "cancel"; request: string; session: string };

/** The request ID and exact payload must be retained until an uncertain response is resolved. */
export async function executeCommand(client: Client, command: Command) {
  if (command.kind === "goal") throw new Error("Goal scheduling is not available in this local database adapter");
  const result = command.kind === "habit_create"
    ? await client.rpc("bloom_create_habit", { p_request_id: command.request, p_name: command.name, p_description: command.description, p_time: command.time })
    : command.kind === "habit_update"
    ? await client.rpc("bloom_update_habit", { p_request_id: command.request, p_habit_id: command.habit, p_name: command.name, p_description: command.description, p_time: command.time })
    : command.kind === "habit_archive"
    ? await client.rpc("bloom_archive_habit", { p_request_id: command.request, p_habit_id: command.habit })
    : command.kind === "start"
    ? await client.rpc("bloom_start_session", { p_request_id: command.request, p_habit_id: command.habit })
    : command.kind === "quick"
    ? await client.rpc("bloom_quick_log", { p_request_id: command.request, p_habit_id: command.habit, p_date: command.date, p_estimated_ms: command.estimatedMs, p_note: command.note })
    : command.kind === "pause"
    ? await client.rpc("bloom_pause_session", { p_request_id: command.request, p_session_id: command.session })
    : command.kind === "resume"
    ? await client.rpc("bloom_resume_session", { p_request_id: command.request, p_session_id: command.session })
    : command.kind === "complete"
    ? await client.rpc("bloom_complete_session", { p_request_id: command.request, p_session_id: command.session })
    : await client.rpc("bloom_cancel_session", { p_request_id: command.request, p_session_id: command.session });
  if (result.error) throw result.error;
  return result.data;
}

/** Exhaust PostgREST pages rather than silently dropping history at its default row limit. */
export async function loadWorkspace(client: Client, userId: string) {
  const habits: Habit[] = [];
  const sessions: SessionRow[] = [];
  const versions: VersionRow[] = [];
  const pageSize = 500;
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await client.from("habits").select("*").eq("user_id", userId).order("id").range(offset, offset + pageSize - 1);
    if (error) throw error;
    habits.push(...data);
    if (data.length < pageSize) break;
  }
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await client.from("habit_sessions").select("*").eq("user_id", userId).order("id").range(offset, offset + pageSize - 1);
    if (error) throw error;
    sessions.push(...data);
    if (data.length < pageSize) break;
  }
  for (let offset = 0;; offset += pageSize) {
    const { data, error } = await client.from("habit_versions").select("*").eq("user_id", userId).order("id").range(offset, offset + pageSize - 1);
    if (error) throw error;
    versions.push(...data);
    if (data.length < pageSize) break;
  }
  const active = sessions.filter(s => s.source === "timed" && (s.status === "running" || s.status === "paused"));
  if (active.length > 1) throw new Error("Multiple active timers found; refresh or contact support.");
  const segments: SegmentRow[] = [];
  if (active.length) for (let offset = 0;; offset += pageSize) {
    const { data, error } = await client.from("habit_session_segments").select("*").eq("user_id", userId).eq("session_id", active[0].id).order("id").range(offset, offset + pageSize - 1);
    if (error) throw error;
    segments.push(...data);
    if (data.length < pageSize) break;
  }
  return { habits, sessions, segments, versions };
}
