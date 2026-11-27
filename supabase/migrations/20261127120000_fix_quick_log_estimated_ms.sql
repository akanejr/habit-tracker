-- Phase 4: Fix quick_log to use estimated_ms correctly
-- 
-- The final_corrections migration incorrectly changed quick_log to insert into
-- duration_ms instead of estimated_ms. Quick logs should use estimated_ms since
-- the user is providing an estimate, not a measured duration.

BEGIN;

-- Drop the incorrect overload
DROP FUNCTION IF EXISTS public.bloom_quick_log(text, uuid, integer, text);

-- Recreate with correct estimated_ms usage
CREATE OR REPLACE FUNCTION public.bloom_quick_log(
  p_request_id text,
  p_habit_id uuid,
  p_estimated_ms integer,
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
    'estimated_ms', p_estimated_ms,
    'note', p_note
  );

  -- INSERT-FIRST idempotency pattern
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

  -- Validate habit
  IF NOT EXISTS (
    SELECT 1 FROM public.habits
    WHERE id = p_habit_id AND user_id = v_user_id AND is_active = true
  ) THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';
    RAISE EXCEPTION 'Habit not found or not active';
  END IF;

  -- Validate estimated_ms
  IF p_estimated_ms < 0 THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';
    RAISE EXCEPTION 'Estimated duration must be non-negative';
  END IF;

  -- Get current habit version
  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = p_habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;

  -- Create quick log session with estimated_ms (NOT duration_ms)
  INSERT INTO public.habit_sessions (
    user_id, habit_id, source, status, recording_mode,
    started_at, completed_at, estimated_ms, notes,
    start_version_id, completion_version_id
  ) VALUES (
    v_user_id, p_habit_id, 'quick', 'completed', 'quick',
    v_now, v_now, p_estimated_ms, p_note,
    v_version_id, v_version_id
  ) RETURNING id INTO v_session_id;

  v_result := jsonb_build_object(
    'session_id', v_session_id,
    'status', 'completed',
    'completed_at', v_now,
    'estimated_ms', p_estimated_ms
  );

  -- Update idempotency record with result
  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'quick_log';

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.bloom_quick_log(text, uuid, integer, text) IS
'Creates a quick log session with estimated duration. Uses estimated_ms (not duration_ms) since the user is providing an estimate, not a measured duration.';

-- ============================================================================
-- FIX 2: bloom_complete_session must set completed_on
-- ============================================================================

-- Read the current function source and patch it
-- We need to add completed_on = public.lagos_date(v_now) to the UPDATE statement

-- Drop and recreate with the fix
DROP FUNCTION IF EXISTS public.bloom_complete_session(text, uuid);

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
  v_session_status text;
  v_habit_id uuid;
  v_duration_ms bigint;
  v_version_id bigint;
  v_completed_on date;
  v_result jsonb;
  v_payload jsonb;
  v_existing record;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  -- INSERT-FIRST idempotency pattern
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

  -- Validate session
  SELECT status, habit_id INTO v_session_status, v_habit_id
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session_status IS NULL THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';
    RAISE EXCEPTION 'Session not found or access denied';
  END IF;

  IF v_session_status NOT IN ('running', 'paused') THEN
    DELETE FROM public.session_command_requests
    WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';
    RAISE EXCEPTION 'Session cannot be completed (current status: %)', v_session_status;
  END IF;

  -- End current segment if running
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  -- Calculate total duration from segments
  SELECT COALESCE(SUM(
    EXTRACT(EPOCH FROM (COALESCE(ended_at, v_now) - started_at)) * 1000
  ), 0)::bigint INTO v_duration_ms
  FROM public.habit_session_segments
  WHERE session_id = p_session_id;

  -- Get current habit version
  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = v_habit_id
  ORDER BY recorded_at DESC, id DESC
  LIMIT 1;

  -- Calculate completed_on in Africa/Lagos timezone
  v_completed_on := public.lagos_date(v_now);

  -- Update session (INCLUDING completed_on)
  UPDATE public.habit_sessions
  SET 
    status = 'completed',
    completed_at = v_now,
    completed_on = v_completed_on,
    duration_ms = v_duration_ms,
    completion_version_id = v_version_id
  WHERE id = p_session_id;

  v_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'completed',
    'completed_at', v_now,
    'completed_on', v_completed_on,
    'duration_ms', v_duration_ms
  );

  -- Update idempotency record
  UPDATE public.session_command_requests
  SET operation_result = v_result, processed_at = v_now
  WHERE request_id = p_request_id AND user_id = v_user_id AND operation_type = 'complete_session';

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.bloom_complete_session(text, uuid) IS
'Completes an active session. Calculates duration from segments and sets completed_on using Africa/Lagos timezone.';

COMMIT;
