-- Phase 2: Session Tables
-- Creates habit_sessions and habit_session_segments tables
-- Supports multiple sessions per habit per day with duration tracking

BEGIN;

-- ============================================================================
-- TIMEZONE HELPER FUNCTIONS
-- ============================================================================

-- Convert timestamp to Africa/Lagos date
CREATE OR REPLACE FUNCTION public.lagos_date(ts timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT (ts AT TIME ZONE 'Africa/Lagos')::date;
$$;

-- Get Monday of the week containing the given date
CREATE OR REPLACE FUNCTION public.lagos_week_start(d date)
RETURNS date
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
  SELECT d - ((EXTRACT(DOW FROM d)::integer + 6) % 7);
$$;

COMMENT ON FUNCTION public.lagos_date IS 'Converts a timestamp to Africa/Lagos date (WAT, UTC+1, no DST)';
COMMENT ON FUNCTION public.lagos_week_start IS 'Returns the Monday of the week containing the given date';

-- ============================================================================
-- HABIT_SESSIONS TABLE
-- ============================================================================

CREATE TABLE public.habit_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  habit_id uuid NOT NULL REFERENCES public.habits(id) ON DELETE CASCADE,
  
  -- Session metadata
  source text NOT NULL CHECK (source IN ('timed', 'quick', 'legacy')),
  status text NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'cancelled')),
  recording_mode text NOT NULL CHECK (recording_mode IN ('timer', 'quick', 'legacy')),
  
  -- Completion tracking
  completed_on date CHECK (completed_on IS NULL OR completed_on >= '2020-01-01'),
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  estimated_ms bigint CHECK (estimated_ms IS NULL OR estimated_ms >= 0),
  note text,
  
  -- Timestamps
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  
  -- Version tracking
  start_version_id bigint REFERENCES public.habit_versions(id),
  completion_version_id bigint REFERENCES public.habit_versions(id),
  
  -- Legacy reference
  legacy_log_id uuid REFERENCES public.habit_logs(id),
  
  -- Constraints
  CONSTRAINT habit_sessions_duration_exclusive CHECK (duration_ms IS NULL OR estimated_ms IS NULL),
  CONSTRAINT habit_sessions_timed_only_running CHECK (source = 'timed' OR status != 'running'),
  CONSTRAINT habit_sessions_completed_date CHECK (status = 'completed' OR completed_on IS NULL),
  CONSTRAINT habit_sessions_completed_duration CHECK (status = 'completed' OR (duration_ms IS NULL AND estimated_ms IS NULL)),
  CONSTRAINT habit_sessions_timed_start CHECK (source != 'timed' OR started_at IS NOT NULL),
  CONSTRAINT habit_sessions_timed_version CHECK (source != 'timed' OR start_version_id IS NOT NULL)
);

COMMENT ON TABLE public.habit_sessions IS 'Canonical record of all habit sessions (timed, quick logs, legacy)';
COMMENT ON COLUMN public.habit_sessions.source IS 'How the session was created: timed (timer), quick (manual log), legacy (migrated)';
COMMENT ON COLUMN public.habit_sessions.status IS 'Current state: running, paused, completed, cancelled';
COMMENT ON COLUMN public.habit_sessions.recording_mode IS 'Duration measurement: timer (measured), quick (estimated), legacy (unknown)';
COMMENT ON COLUMN public.habit_sessions.completed_on IS 'Africa/Lagos date when session was completed';
COMMENT ON COLUMN public.habit_sessions.duration_ms IS 'Measured duration in milliseconds (timed sessions only)';
COMMENT ON COLUMN public.habit_sessions.estimated_ms IS 'User-provided estimate in milliseconds (quick logs only)';
COMMENT ON COLUMN public.habit_sessions.start_version_id IS 'Habit version at session start (timed sessions)';
COMMENT ON COLUMN public.habit_sessions.completion_version_id IS 'Habit version at completion (all completed sessions)';

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX habit_sessions_user_id_idx ON public.habit_sessions(user_id);
CREATE INDEX habit_sessions_habit_id_idx ON public.habit_sessions(habit_id);
CREATE INDEX habit_sessions_completed_on_idx ON public.habit_sessions(completed_on) WHERE completed_on IS NOT NULL;
CREATE INDEX habit_sessions_active_idx ON public.habit_sessions(user_id) WHERE status IN ('running', 'paused');
CREATE INDEX habit_sessions_habit_completed_idx ON public.habit_sessions(habit_id, completed_on DESC) WHERE status = 'completed';

-- ============================================================================
-- HABIT_SESSION_SEGMENTS TABLE
-- ============================================================================

CREATE TABLE public.habit_session_segments (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  session_id uuid NOT NULL REFERENCES public.habit_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.habit_session_segments IS 'Individual timer intervals for timed sessions (supports pause/resume)';
COMMENT ON COLUMN public.habit_session_segments.started_at IS 'When this segment started';
COMMENT ON COLUMN public.habit_session_segments.ended_at IS 'When this segment ended (NULL if currently running)';

-- ============================================================================
-- SEGMENT INDEXES
-- ============================================================================

CREATE INDEX habit_session_segments_session_id_idx ON public.habit_session_segments(session_id);
CREATE INDEX habit_session_segments_user_id_idx ON public.habit_session_segments(user_id);
CREATE INDEX habit_session_segments_active_idx ON public.habit_session_segments(session_id) WHERE ended_at IS NULL;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.habit_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.habit_session_segments ENABLE ROW LEVEL SECURITY;

-- Sessions policies
CREATE POLICY habit_sessions_select_own ON public.habit_sessions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY habit_sessions_insert_own ON public.habit_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.habits
      WHERE habits.id = habit_sessions.habit_id
      AND habits.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY habit_sessions_update_own ON public.habit_sessions
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY habit_sessions_delete_own ON public.habit_sessions
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- Segments policies
CREATE POLICY habit_session_segments_select_own ON public.habit_session_segments
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY habit_session_segments_insert_own ON public.habit_session_segments
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.habit_sessions
      WHERE habit_sessions.id = habit_session_segments.session_id
      AND habit_sessions.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY habit_session_segments_update_own ON public.habit_session_segments
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- No delete policy - segments are managed via session deletion cascade

-- ============================================================================
-- PRIVILEGES
-- ============================================================================

REVOKE ALL PRIVILEGES ON TABLE public.habit_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.habit_session_segments FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.habit_session_segments_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.habit_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.habit_session_segments TO authenticated;
GRANT USAGE ON SEQUENCE public.habit_session_segments_id_seq TO authenticated;

REVOKE ALL PRIVILEGES ON FUNCTION public.lagos_date(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.lagos_week_start(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lagos_date(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lagos_week_start(date) TO authenticated;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Ensure user_id consistency in segments
CREATE OR REPLACE FUNCTION public.validate_segment_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id != (SELECT user_id FROM public.habit_sessions WHERE id = NEW.session_id) THEN
    RAISE EXCEPTION 'Segment user_id must match session user_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_segment_insert
  BEFORE INSERT ON public.habit_session_segments
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_segment_user();

REVOKE ALL PRIVILEGES ON FUNCTION public.validate_segment_user() FROM PUBLIC, anon, authenticated;

COMMIT;
