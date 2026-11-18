import type { Database } from "@/types/database";
export type Habit = Database["public"]["Tables"]["habits"]["Row"];
export type HabitLog = Database["public"]["Tables"]["habit_logs"]["Row"];

/** Only days from the current Lagos week up to today count toward the goal. */
export function countThisWeek(logs: HabitLog[], habitId: string, start: string, today: string): number {
  return logs.filter(log => log.habit_id === habitId && log.completed_on >= start && log.completed_on <= today).length;
}

export function todayHabits(habits: Habit[], logs: HabitLog[], start: string, today: string): Habit[] {
  return habits.filter(habit => {
    if (!habit.is_active) return false;
    if (habit.frequency === "daily") return true;
    if (habit.frequency !== "weekly" || !habit.target_per_week) return false;
    const doneToday = logs.some(log => log.habit_id === habit.id && log.completed_on === today);
    return doneToday || countThisWeek(logs, habit.id, start, today) < habit.target_per_week;
  });
}

export function dailyProgress(habits: Habit[], logs: HabitLog[], today: string) {
  const completed = habits.filter(habit => logs.some(log => log.habit_id === habit.id && log.completed_on === today)).length;
  return { completed, total: habits.length, percentage: habits.length ? Math.round((completed / habits.length) * 100) : 0 };
}
