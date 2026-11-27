-- Phase 5: Operation Failure Log
-- General-purpose failure tracking with bounded retry policies.
--
-- SAFETY:
--   - Destructive operations (complete_session, cancel_session, delete_account)
--     are NOT auto-retried (auto_retryable = false).
--   - Only idempotent operations (start_session, set_weekly_goal) are retryable.
--   - Exponential backoff: retry delays double after each attempt (1m, 2m, 4m, 8m, 16m).
--   - Bounded by max_attempts (default 5). Failed operations beyond max are marked
--     'exhausted' and will not be retried.
--   - retry_failed_operations() returns pending failures for processing; it does NOT
--     execute the operations itself. The caller decides what to do with them.
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
  attempt_count integer NOT NULL DEFAULT 1,
  max_attempts integer NOT NULL DEFAULT 5
    CHECK (max_attempts >= 1 AND max_attempts <= 10),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retrying', 'resolved', 'exhausted', 'not_retryable')),
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  auto_retryable boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.operation_failures IS
  'General-purpose failure tracking with bounded retry and exponential backoff';
COMMENT ON COLUMN public.operation_failures.auto_retryable IS
  'Whether this operation type can be safely auto-retried (idempotent operations only)';
COMMENT ON COLUMN public.operation_failures.status IS
  'pending=awaiting retry, retrying=being retried, resolved=succeeded, '
  'exhausted=max attempts reached, not_retryable=destructive op, manual intervention needed';

-- Indexes
CREATE INDEX operation_failures_retryable_idx
  ON public.operation_failures (status, next_retry_at)
  WHERE status IN ('pending', 'retrying') AND auto_retryable = true;

CREATE INDEX operation_failures_user_pending_idx
  ON public.operation_failures (user_id, status)
  WHERE status IN ('pending', 'retrying');

CREATE INDEX operation_failures_not_retryable_idx
  ON public.operation_failures (user_id)
  WHERE status = 'not_retryable';

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
    p_error_message, 1, p_max_attempts, v_status,
    (v_status = 'pending'), now()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_operation_failure IS
  'Records a failed operation for potential retry. Destructive operations '
  '(complete_session, cancel_session, delete_account) are forced to not_retryable.';

REVOKE ALL PRIVILEGES ON FUNCTION public.record_operation_failure(text, jsonb, text, boolean, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_operation_failure(text, jsonb, text, boolean, integer)
  TO authenticated;

-- ============================================================================
-- RETRY FAILED OPERATIONS (returns pending failures — does NOT execute them)
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
BEGIN
  -- Increment attempt count and apply exponential backoff for all due retries
  UPDATE public.operation_failures SET
    status = 'retrying',
    attempt_count = attempt_count + 1,
    next_retry_at = now() + (
      -- Exponential backoff: 2^attempt minutes (1m, 2m, 4m, 8m, 16m...)
      (power(2, attempt_count)::integer || ' minutes')::interval
    ),
    updated_at = now()
  WHERE status = 'pending'
    AND auto_retryable = true
    AND next_retry_at <= now()
    AND attempt_count < max_attempts;

  -- Mark exhausted operations (reached max attempts)
  UPDATE public.operation_failures SET
    status = 'exhausted',
    updated_at = now()
  WHERE status = 'retrying'
    AND attempt_count >= max_attempts;

  -- Return all currently retrying operations (caller decides what to do)
  RETURN QUERY
  SELECT
    of2.id,
    of2.user_id,
    of2.operation_type,
    of2.payload,
    of2.attempt_count,
    of2.max_attempts,
    of2.error_message
  FROM public.operation_failures of2
  WHERE of2.status = 'retrying';

  -- Mark returned operations back to pending for next retry cycle
  UPDATE public.operation_failures SET
    status = 'pending',
    updated_at = now()
  WHERE status = 'retrying';
END;
$$;

COMMENT ON FUNCTION public.retry_failed_operations IS
  'Finds pending retryable failures due for retry, applies exponential backoff, '
  'marks exhausted operations, and returns retrying failures for the caller to process. '
  'Does NOT execute operations — the caller decides. SECURITY DEFINER.';

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_failed_operations() FROM PUBLIC, anon, authenticated;
-- Only service_role can call retry (SECURITY DEFINER bypasses RLS)

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
    updated_at = now()
  WHERE id = p_failure_id
    AND status IN ('pending', 'retrying');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Operation failure % not found or already resolved/exhausted', p_failure_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.resolve_operation_failure IS
  'Marks an operation failure as resolved after successful retry.';

REVOKE ALL PRIVILEGES ON FUNCTION public.resolve_operation_failure(bigint) FROM PUBLIC, anon, authenticated;

COMMIT;
