-- Fix: Allow cancelled sessions to have estimated_ms
-- The original constraint only allowed completed sessions to have duration info,
-- but cancelled sessions should preserve accumulated duration in estimated_ms

ALTER TABLE public.habit_sessions
  DROP CONSTRAINT IF EXISTS habit_sessions_completed_duration;

ALTER TABLE public.habit_sessions
  ADD CONSTRAINT habit_sessions_completed_duration
  CHECK (
    status IN ('completed', 'cancelled')
    OR (duration_ms IS NULL AND estimated_ms IS NULL)
  );

COMMENT ON CONSTRAINT habit_sessions_completed_duration ON public.habit_sessions IS
  'Only completed and cancelled sessions may have duration information. '
  'Running and paused sessions must have both duration_ms and estimated_ms as NULL. '
  'Cancelled sessions use estimated_ms to preserve accumulated time from stale recovery.';
