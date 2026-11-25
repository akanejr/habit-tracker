-- Final corrections for Phase 2
-- 1. Fix idempotency race condition using INSERT-first pattern
-- 2. Update get_active_goal() for deterministic ordering with id tie-breaker

BEGIN;

-- ============================================================================
-- FIX 1: Update get_active_goal() to use three-level ordering
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_active_goal(uuid, date);

CREATE OR REPLACE FUNCTION public.get_active_goal(
  p_habit_id uuid,
  p_week date
)
RETURNS TABLE (
  id bigint,
  weekly_session_target integer,
  goal_confirmed boolean,
  effective_week date,
  recorded_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 
    g.id,
    g.weekly_session_target,
    g.goal_confirmed,
    g.effective_week,
    g.recorded_at
  FROM public.habit_session_goal_versions g
  WHERE g.habit_id = p_habit_id
    AND g.effective_week <= p_week
    AND g.goal_confirmed = true
  ORDER BY g.effective_week DESC, g.recorded_at DESC, g.id DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_active_goal IS 
'Returns the active goal for a habit in a given week. Orders by: (1) most recent effective_week, (2) most recent recorded_at, (3) highest id (tie-breaker for equal timestamps).';

-- ============================================================================
-- FIX 2: Rewrite bloom_start_session with INSERT-first idempotency pattern
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bloom_start_session(
  p_request_id text,
  p_habit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_id uuid;
  v_version_id bigint;
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
BEGIN
  -- Get authenticated user
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Build payload for idempotency check
  v_payload := jsonb_build_object('habit_id', p_habit_id);

  -- INSERT-FIRST PATTERN: Try to claim this request_id
  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'start_session', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    -- Someone else already claimed this request_id
    -- Fetch their result
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'start_session';
    
    -- Check if payload matches
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    -- Return cached result
    RETURN v_existing.operation_result;
  END;

  -- We won the race - perform the actual operation
  -- Validate habit exists and belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM public.habits
    WHERE id = p_habit_id AND user_id = v_user_id AND is_active = true
  ) THEN
    -- Clean up the request record since operation failed
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'start_session';
    RAISE EXCEPTION 'Habit not found or not active';
  END IF;

  -- Check for active session
  IF EXISTS (
    SELECT 1 FROM public.habit_sessions
    WHERE user_id = v_user_id AND status IN ('running', 'paused')
  ) THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'start_session';
    RAISE EXCEPTION 'Another session is already active';
  END IF;

  -- Get latest habit version
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

  -- Build result
  v_result := jsonb_build_object(
    'session_id', v_session_id,
    'status', 'running',
    'started_at', v_now
  );

  -- Update request record with result
  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'start_session';

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.bloom_start_session IS 
'Starts a new timed session. Uses INSERT-first pattern for idempotency: concurrent duplicate requests serialize via unique constraint, losing request returns cached result.';

-- ============================================================================
-- Apply same pattern to other RPC functions (abbreviated for brevity)
-- ============================================================================

-- bloom_pause_session
CREATE OR REPLACE FUNCTION public.bloom_pause_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
  v_session record;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'pause_session', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'pause_session';
    
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    RETURN v_existing.operation_result;
  END;

  -- Validate session
  SELECT id, user_id, status INTO v_session
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session IS NULL THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'pause_session';
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session.status != 'running' THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'pause_session';
    RAISE EXCEPTION 'Session is not running (status: %)', v_session.status;
  END IF;

  -- Update session status
  UPDATE public.habit_sessions
  SET status = 'paused'
  WHERE id = p_session_id;

  -- End current segment
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'paused',
    'paused_at', v_now
  );

  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'pause_session';

  RETURN v_result;
END;
$$;

-- bloom_resume_session
CREATE OR REPLACE FUNCTION public.bloom_resume_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
  v_session record;
  v_segment_id bigint;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'resume_session', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'resume_session';
    
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    RETURN v_existing.operation_result;
  END;

  SELECT id, user_id, status INTO v_session
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session IS NULL THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'resume_session';
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session.status != 'paused' THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'resume_session';
    RAISE EXCEPTION 'Session is not paused (status: %)', v_session.status;
  END IF;

  UPDATE public.habit_sessions
  SET status = 'running'
  WHERE id = p_session_id;

  INSERT INTO public.habit_session_segments (
    session_id, user_id, started_at
  ) VALUES (
    p_session_id, v_user_id, v_now
  ) RETURNING id INTO v_segment_id;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'segment_id', v_segment_id,
    'status', 'running',
    'resumed_at', v_now
  );

  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'resume_session';

  RETURN v_result;
END;
$$;

-- bloom_complete_session
CREATE OR REPLACE FUNCTION public.bloom_complete_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
  v_session record;
  v_duration_ms integer;
  v_version_id bigint;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'complete_session', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';
    
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    RETURN v_existing.operation_result;
  END;

  SELECT id, user_id, status, habit_id INTO v_session
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session IS NULL THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session.status NOT IN ('running', 'paused') THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';
    RAISE EXCEPTION 'Session cannot be completed (status: %)', v_session.status;
  END IF;

  -- End current segment if running
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  -- Calculate total duration
  SELECT COALESCE(SUM(
    EXTRACT(EPOCH FROM (COALESCE(ended_at, v_now) - started_at)) * 1000
  )::integer, 0) INTO v_duration_ms
  FROM public.habit_session_segments
  WHERE session_id = p_session_id;

  -- Get latest habit version
  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = v_session.habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;

  UPDATE public.habit_sessions
  SET 
    status = 'completed',
    completed_at = v_now,
    duration_ms = v_duration_ms,
    completion_version_id = v_version_id
  WHERE id = p_session_id;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'completed',
    'completed_at', v_now,
    'duration_ms', v_duration_ms
  );

  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';

  RETURN v_result;
END;
$$;

-- bloom_cancel_session
CREATE OR REPLACE FUNCTION public.bloom_cancel_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
  v_session record;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'cancel_session', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'cancel_session';
    
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    RETURN v_existing.operation_result;
  END;

  SELECT id, user_id, status INTO v_session
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session IS NULL THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'cancel_session';
    RAISE EXCEPTION 'Session not found';
  END IF;

  IF v_session.status NOT IN ('running', 'paused') THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'cancel_session';
    RAISE EXCEPTION 'Session cannot be cancelled (status: %)', v_session.status;
  END IF;

  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  UPDATE public.habit_sessions
  SET status = 'cancelled', completed_at = v_now
  WHERE id = p_session_id;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'cancelled',
    'cancelled_at', v_now
  );

  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'cancel_session';

  RETURN v_result;
END;
$$;

-- bloom_quick_log (both overloads)
DROP FUNCTION IF EXISTS public.bloom_quick_log(text, uuid, integer, text);

CREATE OR REPLACE FUNCTION public.bloom_quick_log(
  p_request_id text,
  p_habit_id uuid,
  p_duration_ms integer,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_id uuid;
  v_version_id bigint;
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object(
    'habit_id', p_habit_id,
    'duration_ms', p_duration_ms,
    'note', p_note
  );

  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'quick_log', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';
    
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    RETURN v_existing.operation_result;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.habits
    WHERE id = p_habit_id AND user_id = v_user_id AND is_active = true
  ) THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';
    RAISE EXCEPTION 'Habit not found or not active';
  END IF;

  IF p_duration_ms < 0 THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';
    RAISE EXCEPTION 'Duration must be non-negative';
  END IF;

  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = p_habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;

  INSERT INTO public.habit_sessions (
    user_id, habit_id, source, status, recording_mode,
    started_at, completed_at, duration_ms, notes,
    start_version_id, completion_version_id
  ) VALUES (
    v_user_id, p_habit_id, 'quick', 'completed', 'quick',
    v_now, v_now, p_duration_ms, p_note,
    v_version_id, v_version_id
  ) RETURNING id INTO v_session_id;

  v_result := jsonb_build_object(
    'session_id', v_session_id,
    'status', 'completed',
    'completed_at', v_now,
    'estimated_ms', p_duration_ms
  );

  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';

  RETURN v_result;
END;
$$;

-- bloom_set_weekly_goal
CREATE OR REPLACE FUNCTION public.bloom_set_weekly_goal(
  p_request_id text,
  p_habit_id uuid,
  p_effective_week date,
  p_weekly_target integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_goal_id bigint;
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object(
    'habit_id', p_habit_id,
    'effective_week', p_effective_week,
    'weekly_target', p_weekly_target
  );

  BEGIN
    INSERT INTO public.session_command_requests (
      request_id, user_id, operation_type, operation_payload, operation_result
    ) VALUES (
      p_request_id, v_user_id, 'set_weekly_goal', v_payload, NULL
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT operation_payload, operation_result INTO v_existing
    FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'set_weekly_goal';
    
    IF v_existing.operation_payload != v_payload THEN
      RAISE EXCEPTION 'Request ID % already used with different payload', p_request_id;
    END IF;
    
    RETURN v_existing.operation_result;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.habits
    WHERE id = p_habit_id AND user_id = v_user_id AND is_active = true
  ) THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'set_weekly_goal';
    RAISE EXCEPTION 'Habit not found or not active';
  END IF;

  IF p_effective_week != public.lagos_week_start(p_effective_week) THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'set_weekly_goal';
    RAISE EXCEPTION 'effective_week must be a Monday (Africa/Lagos timezone)';
  END IF;

  IF p_weekly_target IS NOT NULL AND p_weekly_target < 1 THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'set_weekly_goal';
    RAISE EXCEPTION 'weekly_target must be NULL or >= 1';
  END IF;

  INSERT INTO public.habit_session_goal_versions (
    habit_id, user_id, effective_week, weekly_session_target,
    goal_confirmed, recorded_at
  ) VALUES (
    p_habit_id, v_user_id, p_effective_week, p_weekly_target,
    true, v_now
  ) RETURNING id INTO v_goal_id;

  v_result := jsonb_build_object(
    'goal_id', v_goal_id,
    'habit_id', p_habit_id,
    'effective_week', p_effective_week,
    'weekly_target', p_weekly_target,
    'recorded_at', v_now
  );

  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'set_weekly_goal';

  RETURN v_result;
END;
$$;

COMMIT;
