-- Phase 2: Session Lifecycle Functions
-- RPC functions for managing sessions with proper validation and state transitions

BEGIN;

-- ============================================================================
-- SESSION LIFECYCLE FUNCTIONS
-- ============================================================================

-- Start a new timed session
CREATE OR REPLACE FUNCTION public.bloom_start_session(
  p_request_id text,
  p_habit_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id uuid;
  v_version_id bigint;
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
BEGIN
  -- Validate user is authenticated
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate habit exists and belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM public.habits h
    WHERE h.id = p_habit_id AND h.user_id = v_user_id AND h.is_active = true
  ) THEN
    RAISE EXCEPTION 'Habit not found or not active';
  END IF;
  
  -- Check for existing active session
  IF EXISTS (
    SELECT 1 FROM public.habit_sessions s
    WHERE s.user_id = v_user_id AND s.status IN ('running', 'paused')
  ) THEN
    RAISE EXCEPTION 'Another session is already active';
  END IF;
  
  -- Get current habit version
  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = p_habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;
  
  -- Create session
  INSERT INTO public.habit_sessions (
    user_id, habit_id, source, status, recording_mode,
    started_at, start_version_id
  ) VALUES (
    v_user_id, p_habit_id, 'timed', 'running', 'timer',
    v_now, v_version_id
  ) RETURNING id INTO v_session_id;
  
  -- Create initial segment
  INSERT INTO public.habit_session_segments (
    session_id, user_id, started_at
  ) VALUES (
    v_session_id, v_user_id, v_now
  );
  
  -- Return session data
  RETURN json_build_object(
    'session_id', v_session_id,
    'status', 'running',
    'started_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_start_session IS 'Starts a new timed session with validation';

-- Pause a running session
CREATE OR REPLACE FUNCTION public.bloom_pause_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate session exists and is running
  IF NOT EXISTS (
    SELECT 1 FROM public.habit_sessions s
    WHERE s.id = p_session_id AND s.user_id = v_user_id AND s.status = 'running'
  ) THEN
    RAISE EXCEPTION 'Session not found or not running';
  END IF;
  
  -- Close current segment
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;
  
  -- Update session status
  UPDATE public.habit_sessions
  SET status = 'paused'
  WHERE id = p_session_id;
  
  RETURN json_build_object(
    'session_id', p_session_id,
    'status', 'paused',
    'paused_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_pause_session IS 'Pauses a running session';

-- Resume a paused session
CREATE OR REPLACE FUNCTION public.bloom_resume_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate session exists and is paused
  IF NOT EXISTS (
    SELECT 1 FROM public.habit_sessions s
    WHERE s.id = p_session_id AND s.user_id = v_user_id AND s.status = 'paused'
  ) THEN
    RAISE EXCEPTION 'Session not found or not paused';
  END IF;
  
  -- Update session status
  UPDATE public.habit_sessions
  SET status = 'running'
  WHERE id = p_session_id;
  
  -- Create new segment
  INSERT INTO public.habit_session_segments (
    session_id, user_id, started_at
  ) VALUES (
    p_session_id, v_user_id, v_now
  );
  
  RETURN json_build_object(
    'session_id', p_session_id,
    'status', 'running',
    'resumed_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_resume_session IS 'Resumes a paused session';

-- Complete a session
CREATE OR REPLACE FUNCTION public.bloom_complete_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
  v_duration_ms bigint;
  v_version_id bigint;
  v_habit_id uuid;
  v_completed_on date;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate session exists and is active
  SELECT habit_id INTO v_habit_id
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id AND status IN ('running', 'paused');
  
  IF v_habit_id IS NULL THEN
    RAISE EXCEPTION 'Session not found or not active';
  END IF;
  
  -- Close any open segment
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;
  
  -- Calculate total duration from all segments
  SELECT COALESCE(SUM(
    EXTRACT(EPOCH FROM (COALESCE(ended_at, v_now) - started_at)) * 1000
  ), 0)::bigint INTO v_duration_ms
  FROM public.habit_session_segments
  WHERE session_id = p_session_id;
  
  -- Get completion habit version
  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = v_habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;
  
  -- Calculate completion date in Africa/Lagos
  v_completed_on := public.lagos_date(v_now);
  
  -- Update session
  UPDATE public.habit_sessions
  SET 
    status = 'completed',
    completed_at = v_now,
    completed_on = v_completed_on,
    duration_ms = v_duration_ms,
    completion_version_id = v_version_id
  WHERE id = p_session_id;
  
  RETURN json_build_object(
    'session_id', p_session_id,
    'status', 'completed',
    'completed_at', v_now,
    'completed_on', v_completed_on,
    'duration_ms', v_duration_ms
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_complete_session IS 'Completes an active session with duration calculation';

-- Cancel a session
CREATE OR REPLACE FUNCTION public.bloom_cancel_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate session exists and is active
  IF NOT EXISTS (
    SELECT 1 FROM public.habit_sessions s
    WHERE s.id = p_session_id AND s.user_id = v_user_id AND s.status IN ('running', 'paused')
  ) THEN
    RAISE EXCEPTION 'Session not found or not active';
  END IF;
  
  -- Close any open segment
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;
  
  -- Update session status
  UPDATE public.habit_sessions
  SET status = 'cancelled'
  WHERE id = p_session_id;
  
  RETURN json_build_object(
    'session_id', p_session_id,
    'status', 'cancelled',
    'cancelled_at', v_now
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_cancel_session IS 'Cancels an active session';

-- Create a quick log (manual session entry)
CREATE OR REPLACE FUNCTION public.bloom_quick_log(
  p_request_id text,
  p_habit_id uuid,
  p_date date,
  p_estimated_ms bigint DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session_id uuid;
  v_version_id bigint;
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
  v_today date := public.lagos_date(v_now);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate habit exists and belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM public.habits h
    WHERE h.id = p_habit_id AND h.user_id = v_user_id AND h.is_active = true
  ) THEN
    RAISE EXCEPTION 'Habit not found or not active';
  END IF;
  
  -- Validate date is not in the future
  IF p_date > v_today THEN
    RAISE EXCEPTION 'Cannot log future dates';
  END IF;
  
  -- Get current habit version
  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = p_habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;
  
  -- Create session
  INSERT INTO public.habit_sessions (
    user_id, habit_id, source, status, recording_mode,
    completed_on, estimated_ms, note,
    completed_at, completion_version_id
  ) VALUES (
    v_user_id, p_habit_id, 'quick', 'completed', 'quick',
    p_date, p_estimated_ms, p_note,
    v_now, v_version_id
  ) RETURNING id INTO v_session_id;
  
  RETURN json_build_object(
    'session_id', v_session_id,
    'status', 'completed',
    'completed_on', p_date,
    'estimated_ms', p_estimated_ms
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_quick_log IS 'Creates a quick log session with estimated duration';

-- ============================================================================
-- GOAL MANAGEMENT FUNCTIONS
-- ============================================================================

-- Set a weekly goal
CREATE OR REPLACE FUNCTION public.bloom_set_weekly_goal(
  p_request_id text,
  p_habit_id uuid,
  p_effective_week date,
  p_weekly_session_target integer
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_goal_id bigint;
  v_user_id uuid := (SELECT auth.uid());
  v_now timestamptz := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  
  -- Validate habit exists and belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM public.habits h
    WHERE h.id = p_habit_id AND h.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Habit not found';
  END IF;
  
  -- Validate effective_week is a Monday
  IF p_effective_week != public.lagos_week_start(p_effective_week) THEN
    RAISE EXCEPTION 'Effective week must be a Monday';
  END IF;
  
  -- Validate target is positive or null
  IF p_weekly_session_target IS NOT NULL AND p_weekly_session_target < 1 THEN
    RAISE EXCEPTION 'Weekly target must be at least 1 or NULL';
  END IF;
  
  -- Create goal version
  INSERT INTO public.habit_session_goal_versions (
    habit_id, user_id, effective_week, weekly_session_target, goal_confirmed
  ) VALUES (
    p_habit_id, v_user_id, p_effective_week, p_weekly_session_target, true
  )
  ON CONFLICT (habit_id, effective_week) DO UPDATE
  SET 
    weekly_session_target = EXCLUDED.weekly_session_target,
    goal_confirmed = true,
    recorded_at = v_now
  RETURNING id INTO v_goal_id;
  
  RETURN json_build_object(
    'goal_id', v_goal_id,
    'habit_id', p_habit_id,
    'effective_week', p_effective_week,
    'weekly_session_target', p_weekly_session_target
  );
END;
$$;

COMMENT ON FUNCTION public.bloom_set_weekly_goal IS 'Sets a weekly session goal effective from the specified Monday';

-- ============================================================================
-- PRIVILEGES
-- ============================================================================

REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_start_session(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_pause_session(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_resume_session(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_complete_session(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_cancel_session(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_quick_log(text, uuid, date, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_set_weekly_goal(text, uuid, date, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bloom_start_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_pause_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_resume_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_complete_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_cancel_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_quick_log(text, uuid, date, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_set_weekly_goal(text, uuid, date, integer) TO authenticated;

COMMIT;
