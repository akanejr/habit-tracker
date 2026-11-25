-- Phase 2 Corrective Migration
-- Fixes critical issues identified in technical verification
-- 
-- Issue #1: Race condition in bloom_start_session
-- Issue #2: Goal immutability violation
-- Issue #3: Idempotency not implemented
-- Issue #5: Missing session_goal_type column

BEGIN;

-- ============================================================================
-- ISSUE #5: Add missing session_goal_type column to habits table
-- ============================================================================

ALTER TABLE public.habits 
ADD COLUMN IF NOT EXISTS session_goal_type text 
CHECK (session_goal_type IN ('none', 'weekly', NULL));

COMMENT ON COLUMN public.habits.session_goal_type IS 
'Type of session-based goal for this habit. NULL = not configured, "none" = explicitly no goal, "weekly" = weekly session target';

-- Add notes column to habit_sessions (for quick_log)
ALTER TABLE public.habit_sessions 
ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.habit_sessions.notes IS 'Optional user notes for the session';

-- ============================================================================
-- ISSUE #1: Fix race condition with unique partial index
-- ============================================================================

-- First, clean up any existing duplicate active sessions (should not exist in new db)
DELETE FROM public.habit_sessions s1
USING public.habit_sessions s2
WHERE s1.user_id = s2.user_id
AND s1.status IN ('running', 'paused')
AND s2.status IN ('running', 'paused')
AND s1.created_at > s2.created_at;

-- Create unique partial index to enforce one active session per user
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_user
ON public.habit_sessions (user_id)
WHERE status IN ('running', 'paused');

COMMENT ON INDEX public.one_active_session_per_user IS
'Database-enforced guarantee: only one running or paused session per user at any time';

-- ============================================================================
-- ISSUE #3: Implement idempotency with request tracking table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.session_command_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_type text NOT NULL CHECK (operation_type IN (
    'start_session',
    'pause_session',
    'resume_session',
    'complete_session',
    'cancel_session',
    'quick_log',
    'set_weekly_goal'
  )),
  operation_payload jsonb NOT NULL,
  operation_result jsonb,
  processed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  
  -- Unique constraint: same request_id + user_id + operation_type = duplicate
  CONSTRAINT unique_request_per_user_operation UNIQUE (request_id, user_id, operation_type)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_session_command_requests_lookup
ON public.session_command_requests (user_id, request_id, operation_type);

-- Index for cleanup (optional, for future maintenance)
CREATE INDEX IF NOT EXISTS idx_session_command_requests_processed_at
ON public.session_command_requests (processed_at);

COMMENT ON TABLE public.session_command_requests IS
'Tracks processed RPC requests for idempotency. Prevents duplicate operations on retry.';

COMMENT ON COLUMN public.session_command_requests.request_id IS
'Client-generated request ID for idempotency';

COMMENT ON COLUMN public.session_command_requests.operation_payload IS
'JSON representation of operation parameters for validation';

COMMENT ON COLUMN public.session_command_requests.operation_result IS
'Cached result to return on duplicate requests';

-- RLS policies for session_command_requests
ALTER TABLE public.session_command_requests ENABLE ROW LEVEL SECURITY;

-- Users can only see their own command requests
CREATE POLICY session_command_requests_select_own
ON public.session_command_requests
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Revoke direct access (only accessible via RPC functions)
REVOKE ALL PRIVILEGES ON TABLE public.session_command_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.session_command_requests TO authenticated;

-- ============================================================================
-- ISSUE #2: Fix goal immutability - redesign goal versioning
-- ============================================================================

-- The current implementation uses ON CONFLICT DO UPDATE which violates immutability.
-- New design: Keep all versions immutable, use deterministic ordering to select active goal.
--
-- Key changes:
-- 1. Remove ON CONFLICT DO UPDATE from bloom_set_weekly_goal
-- 2. Allow multiple versions for same effective_week (user can change mind before Monday)
-- 3. Use recorded_at timestamp to determine which version is "current"
-- 4. get_active_goal() returns the latest recorded version for a given week

-- Drop existing unique constraint that prevented multiple versions per week
ALTER TABLE public.habit_session_goal_versions
DROP CONSTRAINT IF EXISTS habit_session_goal_versions_unique_week;

ALTER TABLE public.habit_session_goal_versions
DROP CONSTRAINT IF EXISTS habit_session_goal_versions_habit_id_effective_week_key;

-- Add index for efficient lookups (no unique constraint)
CREATE INDEX IF NOT EXISTS idx_habit_session_goal_versions_week_lookup
ON public.habit_session_goal_versions (habit_id, effective_week, recorded_at DESC);

COMMENT ON TABLE public.habit_session_goal_versions IS
'Immutable history of weekly goal changes. Multiple versions can exist for the same effective_week if user changes their mind before Monday. The latest recorded_at timestamp determines the active goal.';

-- ============================================================================
-- Update bloom_set_weekly_goal to preserve immutability
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_set_weekly_goal(text, uuid, date, integer);

CREATE OR REPLACE FUNCTION public.bloom_set_weekly_goal(
  p_request_id text,
  p_habit_id uuid,
  p_effective_week date,
  p_weekly_target integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_existing_result jsonb;
  v_goal_id bigint;
  v_payload jsonb;
BEGIN
  -- Validate authentication
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate habit ownership
  IF NOT EXISTS (
    SELECT 1 FROM public.habits h
    WHERE h.id = p_habit_id AND h.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Habit not found or access denied';
  END IF;

  -- Validate effective_week is a Monday
  IF EXTRACT(DOW FROM p_effective_week) != 1 THEN
    RAISE EXCEPTION 'effective_week must be a Monday (got day %)', EXTRACT(DOW FROM p_effective_week);
  END IF;

  -- Validate weekly_target (NULL allowed for "no target")
  IF p_weekly_target IS NOT NULL AND (p_weekly_target < 0 OR p_weekly_target > 100) THEN
    RAISE EXCEPTION 'weekly_target must be between 0 and 100 (or NULL for no target)';
  END IF;

  -- Check idempotency
  v_payload := jsonb_build_object(
    'habit_id', p_habit_id,
    'effective_week', p_effective_week,
    'weekly_target', p_weekly_target
  );

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'set_weekly_goal'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    -- Duplicate request, return cached result
    RETURN v_existing_result;
  END IF;

  -- Check if same request_id was used with different payload (error)
  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'set_weekly_goal'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  -- Insert new goal version (IMMUTABLE - no ON CONFLICT DO UPDATE)
  INSERT INTO public.habit_session_goal_versions (
    habit_id,
    user_id,
    effective_week,
    weekly_session_target,
    goal_confirmed,
    recorded_at
  ) VALUES (
    p_habit_id,
    v_user_id,
    p_effective_week,
    p_weekly_target,
    true,
    v_now
  )
  RETURNING id INTO v_goal_id;

  -- Build result
  v_existing_result := jsonb_build_object(
    'goal_id', v_goal_id,
    'habit_id', p_habit_id,
    'effective_week', p_effective_week,
    'weekly_target', p_weekly_target,
    'recorded_at', v_now
  );

  -- Record request for idempotency
  INSERT INTO public.session_command_requests (
    request_id,
    user_id,
    operation_type,
    operation_payload,
    operation_result
  ) VALUES (
    p_request_id,
    v_user_id,
    'set_weekly_goal',
    v_payload,
    v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

COMMENT ON FUNCTION public.bloom_set_weekly_goal IS
'Sets a weekly session goal. Immutable: creates a new version even if one exists for the same week. Latest recorded_at determines active goal. Idempotent via request_id.';

-- ============================================================================
-- Update get_active_goal to return latest version
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_active_goal(uuid, date);

CREATE OR REPLACE FUNCTION public.get_active_goal(
  p_habit_id uuid,
  p_week_start date
)
RETURNS TABLE (
  goal_id bigint,
  weekly_target integer,
  recorded_at timestamptz,
  goal_confirmed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 
    id AS goal_id,
    weekly_session_target AS weekly_target,
    recorded_at,
    goal_confirmed
  FROM public.habit_session_goal_versions
  WHERE habit_id = p_habit_id
    AND effective_week = p_week_start
  ORDER BY recorded_at DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_active_goal IS
'Returns the latest (most recently recorded) goal version for a given habit and week. Returns empty result set if no goal exists.';

-- ============================================================================
-- Update bloom_start_session with idempotency
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_start_session(text, uuid);

CREATE OR REPLACE FUNCTION public.bloom_start_session(
  p_request_id text,
  p_habit_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_id uuid;
  v_segment_id bigint;
  v_start_version_id bigint;
  v_existing_result jsonb;
  v_payload jsonb;
BEGIN
  -- Validate authentication
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Validate habit ownership
  IF NOT EXISTS (
    SELECT 1 FROM public.habits h
    WHERE h.id = p_habit_id AND h.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Habit not found or access denied';
  END IF;

  -- Check idempotency
  v_payload := jsonb_build_object('habit_id', p_habit_id);

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'start_session'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    -- Duplicate request, return cached result
    RETURN v_existing_result;
  END IF;

  -- Check if same request_id was used with different payload (error)
  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'start_session'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  -- Check for existing active session (now protected by unique index)
  -- The unique index will catch concurrent attempts, but we check first for better error message
  IF EXISTS (
    SELECT 1 FROM public.habit_sessions s
    WHERE s.user_id = v_user_id AND s.status IN ('running', 'paused')
  ) THEN
    RAISE EXCEPTION 'Another session is already active';
  END IF;

  -- Get current habit version
  SELECT id INTO v_start_version_id
  FROM public.habit_versions
  WHERE habit_id = p_habit_id
  ORDER BY id DESC
  LIMIT 1;

  IF v_start_version_id IS NULL THEN
    RAISE EXCEPTION 'No habit version found for habit %', p_habit_id;
  END IF;

  -- Create session (unique index will prevent concurrent duplicates)
  INSERT INTO public.habit_sessions (
    user_id,
    habit_id,
    source,
    status,
    recording_mode,
    started_at,
    start_version_id
  ) VALUES (
    v_user_id,
    p_habit_id,
    'timed',
    'running',
    'timer',
    v_now,
    v_start_version_id
  )
  RETURNING id INTO v_session_id;

  -- Create initial segment
  INSERT INTO public.habit_session_segments (
    session_id,
    user_id,
    started_at
  ) VALUES (
    v_session_id,
    v_user_id,
    v_now
  )
  RETURNING id INTO v_segment_id;

  -- Build result
  v_existing_result := jsonb_build_object(
    'session_id', v_session_id,
    'segment_id', v_segment_id,
    'status', 'running',
    'started_at', v_now
  );

  -- Record request for idempotency
  INSERT INTO public.session_command_requests (
    request_id,
    user_id,
    operation_type,
    operation_payload,
    operation_result
  ) VALUES (
    p_request_id,
    v_user_id,
    'start_session',
    v_payload,
    v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

COMMENT ON FUNCTION public.bloom_start_session IS
'Starts a new timed session. Protected by unique index (one active session per user). Idempotent via request_id.';

-- ============================================================================
-- Update bloom_pause_session with idempotency
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_pause_session(text, uuid);

CREATE OR REPLACE FUNCTION public.bloom_pause_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_status text;
  v_existing_result jsonb;
  v_payload jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check idempotency
  v_payload := jsonb_build_object('session_id', p_session_id);

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'pause_session'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    RETURN v_existing_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'pause_session'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  -- Validate session ownership and status
  SELECT status INTO v_session_status
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Session not found or access denied';
  END IF;

  IF v_session_status != 'running' THEN
    RAISE EXCEPTION 'Session is not running (current status: %)', v_session_status;
  END IF;

  -- End current segment
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  -- Update session status
  UPDATE public.habit_sessions
  SET status = 'paused'
  WHERE id = p_session_id;

  v_existing_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'paused',
    'paused_at', v_now
  );

  INSERT INTO public.session_command_requests (
    request_id, user_id, operation_type, operation_payload, operation_result
  ) VALUES (
    p_request_id, v_user_id, 'pause_session', v_payload, v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

-- ============================================================================
-- Update bloom_resume_session with idempotency
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_resume_session(text, uuid);

CREATE OR REPLACE FUNCTION public.bloom_resume_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_status text;
  v_segment_id bigint;
  v_existing_result jsonb;
  v_payload jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'resume_session'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    RETURN v_existing_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'resume_session'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  SELECT status INTO v_session_status
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Session not found or access denied';
  END IF;

  IF v_session_status != 'paused' THEN
    RAISE EXCEPTION 'Session is not paused (current status: %)', v_session_status;
  END IF;

  -- Create new segment
  INSERT INTO public.habit_session_segments (
    session_id,
    user_id,
    started_at
  ) VALUES (
    p_session_id,
    v_user_id,
    v_now
  )
  RETURNING id INTO v_segment_id;

  UPDATE public.habit_sessions
  SET status = 'running'
  WHERE id = p_session_id;

  v_existing_result := jsonb_build_object(
    'session_id', p_session_id,
    'segment_id', v_segment_id,
    'status', 'running',
    'resumed_at', v_now
  );

  INSERT INTO public.session_command_requests (
    request_id, user_id, operation_type, operation_payload, operation_result
  ) VALUES (
    p_request_id, v_user_id, 'resume_session', v_payload, v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

-- ============================================================================
-- Update bloom_complete_session with idempotency
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_complete_session(text, uuid);

CREATE OR REPLACE FUNCTION public.bloom_complete_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_status text;
  v_habit_id uuid;
  v_duration_ms integer;
  v_completion_version_id bigint;
  v_existing_result jsonb;
  v_payload jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'complete_session'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    RETURN v_existing_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'complete_session'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  SELECT status, habit_id INTO v_session_status, v_habit_id
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Session not found or access denied';
  END IF;

  IF v_session_status NOT IN ('running', 'paused') THEN
    RAISE EXCEPTION 'Session cannot be completed (current status: %)', v_session_status;
  END IF;

  -- End current segment if running
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  -- Calculate total duration from segments
  SELECT COALESCE(SUM(
    EXTRACT(EPOCH FROM (COALESCE(ended_at, v_now) - started_at)) * 1000
  ), 0)::integer INTO v_duration_ms
  FROM public.habit_session_segments
  WHERE session_id = p_session_id;

  -- Get current habit version for completion
  SELECT id INTO v_completion_version_id
  FROM public.habit_versions
  WHERE habit_id = v_habit_id
  ORDER BY id DESC
  LIMIT 1;

  -- Update session
  UPDATE public.habit_sessions
  SET 
    status = 'completed',
    completed_at = v_now,
    duration_ms = v_duration_ms,
    completion_version_id = v_completion_version_id
  WHERE id = p_session_id;

  v_existing_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'completed',
    'completed_at', v_now,
    'duration_ms', v_duration_ms
  );

  INSERT INTO public.session_command_requests (
    request_id, user_id, operation_type, operation_payload, operation_result
  ) VALUES (
    p_request_id, v_user_id, 'complete_session', v_payload, v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

-- ============================================================================
-- Update bloom_cancel_session with idempotency
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_cancel_session(text, uuid);

CREATE OR REPLACE FUNCTION public.bloom_cancel_session(
  p_request_id text,
  p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_status text;
  v_existing_result jsonb;
  v_payload jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_payload := jsonb_build_object('session_id', p_session_id);

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'cancel_session'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    RETURN v_existing_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'cancel_session'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  SELECT status INTO v_session_status
  FROM public.habit_sessions
  WHERE id = p_session_id AND user_id = v_user_id
  FOR UPDATE;

  IF v_session_status IS NULL THEN
    RAISE EXCEPTION 'Session not found or access denied';
  END IF;

  IF v_session_status NOT IN ('running', 'paused') THEN
    RAISE EXCEPTION 'Session cannot be cancelled (current status: %)', v_session_status;
  END IF;

  -- End current segment
  UPDATE public.habit_session_segments
  SET ended_at = v_now
  WHERE session_id = p_session_id AND ended_at IS NULL;

  -- Update session
  UPDATE public.habit_sessions
  SET status = 'cancelled',
      completed_at = v_now
  WHERE id = p_session_id;

  v_existing_result := jsonb_build_object(
    'session_id', p_session_id,
    'status', 'cancelled',
    'cancelled_at', v_now
  );

  INSERT INTO public.session_command_requests (
    request_id, user_id, operation_type, operation_payload, operation_result
  ) VALUES (
    p_request_id, v_user_id, 'cancel_session', v_payload, v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

-- ============================================================================
-- Update bloom_quick_log with idempotency
-- ============================================================================

DROP FUNCTION IF EXISTS public.bloom_quick_log(text, uuid, integer, text);

CREATE OR REPLACE FUNCTION public.bloom_quick_log(
  p_request_id text,
  p_habit_id uuid,
  p_estimated_ms integer,
  p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_now timestamptz := now();
  v_session_id uuid;
  v_version_id bigint;
  v_existing_result jsonb;
  v_payload jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.habits h
    WHERE h.id = p_habit_id AND h.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Habit not found or access denied';
  END IF;

  IF p_estimated_ms IS NULL OR p_estimated_ms < 0 THEN
    RAISE EXCEPTION 'estimated_ms must be a non-negative integer';
  END IF;

  v_payload := jsonb_build_object(
    'habit_id', p_habit_id,
    'estimated_ms', p_estimated_ms,
    'notes', p_notes
  );

  SELECT operation_result INTO v_existing_result
  FROM public.session_command_requests
  WHERE request_id = p_request_id
    AND user_id = v_user_id
    AND operation_type = 'quick_log'
    AND operation_payload = v_payload;

  IF v_existing_result IS NOT NULL THEN
    RETURN v_existing_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.session_command_requests
    WHERE request_id = p_request_id
      AND user_id = v_user_id
      AND operation_type = 'quick_log'
      AND operation_payload != v_payload
  ) THEN
    RAISE EXCEPTION 'Request ID % already used with different parameters', p_request_id;
  END IF;

  SELECT id INTO v_version_id
  FROM public.habit_versions
  WHERE habit_id = p_habit_id
  ORDER BY id DESC
  LIMIT 1;

  INSERT INTO public.habit_sessions (
    user_id,
    habit_id,
    source,
    status,
    recording_mode,
    estimated_ms,
    started_at,
    completed_at,
    start_version_id,
    completion_version_id,
    notes
  ) VALUES (
    v_user_id,
    p_habit_id,
    'quick',
    'completed',
    'quick',
    p_estimated_ms,
    v_now,
    v_now,
    v_version_id,
    v_version_id,
    p_notes
  )
  RETURNING id INTO v_session_id;

  v_existing_result := jsonb_build_object(
    'session_id', v_session_id,
    'status', 'completed',
    'estimated_ms', p_estimated_ms,
    'logged_at', v_now
  );

  INSERT INTO public.session_command_requests (
    request_id, user_id, operation_type, operation_payload, operation_result
  ) VALUES (
    p_request_id, v_user_id, 'quick_log', v_payload, v_existing_result
  );

  RETURN v_existing_result;
END;
$$;

-- ============================================================================
-- Grant execute permissions on updated functions
-- ============================================================================

REVOKE ALL ON FUNCTION public.bloom_set_weekly_goal(text, uuid, date, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bloom_start_session(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bloom_pause_session(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bloom_resume_session(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bloom_complete_session(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bloom_cancel_session(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bloom_quick_log(text, uuid, integer, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.bloom_set_weekly_goal(text, uuid, date, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_start_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_pause_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_resume_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_complete_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_cancel_session(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_quick_log(text, uuid, integer, text) TO authenticated;

COMMIT;
