-- Phase 5: Operation Failure Log
-- General-purpose failure tracking with bounded retry policies.
--
-- SAFETY:
--   - Destructive operations (complete_session, cancel_session, delete_account)
--     are NOT auto-retried (auto_retryable = false).
--   - Only idempotent operations (start_session, set_weekly_goal) are retryable.
--   - Exponential backoff: retry delays double after each attempt.
--   - Bounded by max_attempts (default 5). Failures are marked 'exhausted' only
--     after ALL permitted attempts have been delivered and the final attempt
--     has not been resolved.
--   - retry_failed_operations() atomically claims failures using FOR UPDATE SKIP LOCKED
--     and returns ONLY the IDs claimed by the current invocation.
--   - Abandoned claims (worker crash) are recovered after a 5-minute lease timeout.
--
-- RELATIONSHIP TO EXISTING SYSTEMS:
--   - session_command_requests: Provides idempotency (prevents duplicate execution)
--   - incomplete_deletions: Specific to auth deletion failures (Phase 3)
--   - operation_failures: General-purpose, extends the pattern to all operations

BEGIN;

-- ============================================================================
-- OPERATION_FAILURES TABLE
-- ============================================================================

CREATE TABLE public.operation_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5
    CHECK (max_attempts >= 1 AND max_attempts <= 10),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retrying', 'resolved', 'exhausted', 'not_retryable')),
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  auto_retryable boolean NOT NULL DEFAULT false,
  claimed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.operation_failures IS
  'General-purpose failure tracking with bounded retry, exponential backoff, and lease-based claiming';
COMMENT ON COLUMN public.operation_failures.attempt_count IS
  'Number of attempts delivered to workers (0 = never claimed)';
COMMENT ON COLUMN public.operation_failures.auto_retryable IS
  'Whether this operation type can be safely auto-retried (idempotent operations only)';
COMMENT ON COLUMN public.operation_failures.claimed_at IS
  'When this failure was last claimed by a worker. Used for lease-based recovery of abandoned claims.';
COMMENT ON COLUMN public.operation_failures.status IS
  'pending=awaiting retry, retrying=claimed by worker (lease active), resolved=succeeded, '
  'exhausted=all attempts used without resolution, not_retryable=destructive op';

-- Indexes
CREATE INDEX operation_failures_pending_idx
  ON public.operation_failures (status, next_retry_at)
  WHERE status = 'pending' AND auto_retryable = true;

CREATE INDEX operation_failures_retrying_lease_idx
  ON public.operation_failures (claimed_at)
  WHERE status = 'retrying';

CREATE INDEX operation_failures_user_pending_idx
  ON public.operation_failures (user_id, status)
  WHERE status IN ('pending', 'retrying');

-- RLS
ALTER TABLE public.operation_failures ENABLE ROW LEVEL SECURITY;

CREATE POLICY operation_failures_select_own ON public.operation_failures
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY operation_failures_insert_own ON public.operation_failures
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Privileges
REVOKE ALL PRIVILEGES ON TABLE public.operation_failures FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.operation_failures_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.operation_failures TO authenticated;
GRANT USAGE ON SEQUENCE public.operation_failures_id_seq TO authenticated;

-- ============================================================================
-- RECORD OPERATION FAILURE
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_operation_failure(
  p_operation_type text,
  p_payload jsonb,
  p_error_message text,
  p_auto_retryable boolean DEFAULT false,
  p_max_attempts integer DEFAULT 5
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_id bigint;
  v_status text;
BEGIN
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_operation_type IS NULL OR trim(p_operation_type) = '' THEN
    RAISE EXCEPTION 'Operation type is required';
  END IF;

  IF p_max_attempts < 1 OR p_max_attempts > 10 THEN
    RAISE EXCEPTION 'max_attempts must be between 1 and 10';
  END IF;

  -- Destructive operations are NEVER auto-retryable regardless of caller input
  IF p_operation_type IN (
    'complete_session', 'cancel_session', 'delete_account',
    'delete_habit', 'delete_log'
  ) THEN
    v_status := 'not_retryable';
  ELSIF p_auto_retryable THEN
    v_status := 'pending';
  ELSE
    v_status := 'not_retryable';
  END IF;

  INSERT INTO public.operation_failures (
    user_id, operation_type, payload, error_message,
    attempt_count, max_attempts, status, auto_retryable, next_retry_at
  ) VALUES (
    v_user_id, p_operation_type, COALESCE(p_payload, '{}'::jsonb),
    p_error_message, 0, p_max_attempts, v_status,
    (v_status = 'pending'), now()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_operation_failure IS
  'Records a failed operation for potential retry. attempt_count starts at 0 (never claimed). '
  'Destructive operations are forced to not_retryable.';

REVOKE ALL PRIVILEGES ON FUNCTION public.record_operation_failure(text, jsonb, text, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_operation_failure(text, jsonb, text, boolean, integer)
  TO authenticated;

-- ============================================================================
-- RETRY FAILED OPERATIONS
--
-- Atomically claims pending failures using FOR UPDATE SKIP LOCKED.
-- Returns ONLY the IDs claimed by THIS invocation — no cross-worker leakage.
--
-- EXHAUSTION LOGIC:
--   1. Recover abandoned claims first (retrying + stale lease → pending)
--   2. Mark as exhausted: retrying rows where attempt_count >= max_attempts
--      (these were delivered previously but never resolved)
--   3. Claim new pending rows where attempt_count < max_attempts
--   4. Return only the newly claimed rows
--
-- This ensures every permitted attempt is delivered to a worker before
-- exhaustion is checked on the subsequent call.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retry_failed_operations()
RETURNS TABLE (
  failure_id bigint,
  user_id uuid,
  operation_type text,
  payload jsonb,
  attempt_count integer,
  max_attempts integer,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease_timeout interval := interval '5 minutes';
BEGIN
  -- ========================================================================
  -- STEP 1: Recover abandoned claims
  -- Workers that crashed after claiming leave rows stuck in 'retrying'.
  -- If claimed_at is older than the lease timeout, reset to 'pending'.
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'pending',
    claimed_at = NULL,
    next_retry_at = now(),
    updated_at = now()
  WHERE status = 'retrying'
    AND claimed_at IS NOT NULL
    AND claimed_at < now() - v_lease_timeout;

  -- ========================================================================
  -- STEP 2: Exhaust failures that used all attempts without resolution
  -- These are 'retrying' rows where attempt_count >= max_attempts.
  -- They were delivered on a previous call but never resolved.
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'exhausted',
    updated_at = now()
  WHERE status = 'retrying'
    AND attempt_count >= max_attempts;

  -- ========================================================================
  -- STEP 3: Atomically claim pending failures and return ONLY claimed IDs
  -- Uses UPDATE...RETURNING for atomic capture — no second SELECT needed.
  -- FOR UPDATE SKIP LOCKED ensures concurrent workers get distinct rows.
  -- ========================================================================
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.operation_failures SET
      status = 'retrying',
      attempt_count = attempt_count + 1,
      claimed_at = now(),
      next_retry_at = now() + (
        (power(2, attempt_count + 1)::integer || ' minutes')::interval
      ),
      updated_at = now()
    WHERE id IN (
      SELECT id FROM public.operation_failures
      WHERE status = 'pending'
        AND auto_retryable = true
        AND next_retry_at <= now()
        AND attempt_count < max_attempts
      ORDER BY id
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      public.operation_failures.id,
      public.operation_failures.user_id,
      public.operation_failures.operation_type,
      public.operation_failures.payload,
      public.operation_failures.attempt_count,
      public.operation_failures.max_attempts,
      public.operation_failures.error_message
  )
  SELECT
    c.id,
    c.user_id,
    c.operation_type,
    c.payload,
    c.attempt_count,
    c.max_attempts,
    c.error_message
  FROM claimed c
  ORDER BY c.id;
END;
$$;

COMMENT ON FUNCTION public.retry_failed_operations IS
  'Atomically claims pending retryable failures using FOR UPDATE SKIP LOCKED. '
  'Returns ONLY the IDs claimed by this invocation. '
  'Recovers abandoned claims (lease > 5 min). '
  'Marks exhausted failures (all attempts delivered, none resolved). '
  'Does NOT execute operations — the caller decides. SECURITY DEFINER.';

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_failed_operations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_operations() TO service_role;

-- ============================================================================
-- RESOLVE OPERATION FAILURE (mark as resolved after successful retry)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_operation_failure(p_failure_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.operation_failures SET
    status = 'resolved',
    resolved_at = now(),
    claimed_at = NULL,
    updated_at = now()
  WHERE id = p_failure_id
    AND status = 'retrying';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operation failure % not found, not in retrying state, or already resolved/exhausted', p_failure_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.resolve_operation_failure IS
  'Marks a retrying operation failure as resolved after successful retry. '
  'Only works on failures in "retrying" state (actively claimed).';

REVOKE ALL PRIVILEGES ON FUNCTION public.resolve_operation_failure(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_operation_failure(bigint) TO service_role;

COMMIT;
