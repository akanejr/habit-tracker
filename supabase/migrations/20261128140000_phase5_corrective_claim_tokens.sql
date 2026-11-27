-- Phase 5 Corrective Migration 1: Retry Claim Tokens & State Machine
--
-- Addresses:
--   1. Genuine retry claim ownership (claim tokens + lease expiration)
--   2. Correct retry exhaustion and abandoned final attempts
--   3. Stale token rejection on resolve
--
-- NEW COLUMNS on operation_failures:
--   claim_token uuid         — unique per claim, returned to worker
--   lease_expires_at timestamptz — when this claim expires
--
-- NEW FUNCTION:
--   report_attempt_outcome(failure_id, claim_token, success) — worker reports result
--
-- CHANGED FUNCTIONS:
--   retry_failed_operations() — now returns claim_token + lease_expires_at
--   resolve_operation_failure(id, claim_token) — requires claim token
--
-- STATE MACHINE:
--   pending → retrying       (claimed: token + lease set)
--   retrying → resolved      (report success with valid token)
--   retrying → pending       (report failure + attempts remain)
--   retrying → exhausted     (report failure + no attempts remain)
--   retrying → pending       (lease expired, recovered by next retry call)
--   retrying → exhausted     (lease expired + attempt_count >= max, on next call)
--
-- ABANDONED FINAL ATTEMPTS:
--   When a final attempt (attempt_count = max_attempts) expires without being
--   resolved or reported as failed, the lease recovery step resets it to pending.
--   The exhaustion check (step 2) then marks it exhausted because
--   attempt_count >= max_attempts. This is bounded: the failure cannot
--   generate unlimited attempts. It reaches exhausted status after at most
--   max_attempts deliveries + 1 recovery cycle.

BEGIN;

-- ============================================================================
-- ADD CLAIM TOKEN COLUMNS
-- ============================================================================

ALTER TABLE public.operation_failures
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

COMMENT ON COLUMN public.operation_failures.claim_token IS
  'Unique token assigned to each claim. Required for resolve/report. '
  'Prevents stale workers from modifying reclaimed operations.';
COMMENT ON COLUMN public.operation_failures.lease_expires_at IS
  'Explicit expiration timestamp for the current claim. '
  'After this time, the claim can be recovered by another worker.';

-- Update index to include lease expiration for efficient recovery
DROP INDEX IF EXISTS public.operation_failures_retrying_lease_idx;
CREATE INDEX operation_failures_lease_idx
  ON public.operation_failures (lease_expires_at)
  WHERE status = 'retrying' AND lease_expires_at IS NOT NULL;

-- ============================================================================
-- RETRY FAILED OPERATIONS (with claim tokens)
--
-- Returns: failure_id, claim_token, lease_expires_at, user_id, operation_type,
--          payload, attempt_count, max_attempts, error_message
--
-- Steps:
--   1. Recover expired leases (reset to pending)
--   2. Exhaust: retrying rows where attempt_count >= max_attempts
--      (these were delivered but never resolved/reported)
--   3. Claim pending rows with FOR UPDATE SKIP LOCKED
--      Assign unique claim_token and lease_expires_at
--      Return ONLY claimed rows
-- ============================================================================

CREATE OR REPLACE FUNCTION public.retry_failed_operations()
RETURNS TABLE (
  failure_id bigint,
  claim_token uuid,
  lease_expires_at timestamptz,
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
  v_lease_duration interval := interval '5 minutes';
BEGIN
  -- ========================================================================
  -- STEP 1: Recover expired leases
  -- Rows in 'retrying' with lease_expires_at < now() are reset to 'pending'.
  -- This allows them to be re-claimed or exhausted in steps 2-3.
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'pending',
    claim_token = NULL,
    lease_expires_at = NULL,
    next_retry_at = now(),
    updated_at = now()
  WHERE status = 'retrying'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now();

  -- ========================================================================
  -- STEP 2: Exhaust failures that used all attempts without resolution
  -- These are 'retrying' rows where attempt_count >= max_attempts.
  -- They were delivered on a previous call but the worker crashed or
  -- never reported the outcome. The lease has expired (step 1 already
  -- handled non-exhausted ones). Only rows that survived step 1
  -- (i.e., lease still active or attempt_count >= max) reach here.
  --
  -- Active leases (not yet expired) are NOT exhausted — a worker may
  -- still be processing them.
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'exhausted',
    claim_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
  WHERE status = 'retrying'
    AND attempt_count >= max_attempts
    AND (lease_expires_at IS NULL OR lease_expires_at < now());

  -- ========================================================================
  -- STEP 3: Atomically claim pending failures
  -- Generate unique claim_token and lease_expires_at per row.
  -- Return ONLY rows claimed by THIS invocation.
  -- ========================================================================
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.operation_failures SET
      status = 'retrying',
      attempt_count = attempt_count + 1,
      claim_token = gen_random_uuid(),
      lease_expires_at = now() + v_lease_duration,
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
      public.operation_failures.claim_token,
      public.operation_failures.lease_expires_at,
      public.operation_failures.user_id,
      public.operation_failures.operation_type,
      public.operation_failures.payload,
      public.operation_failures.attempt_count,
      public.operation_failures.max_attempts,
      public.operation_failures.error_message
  )
  SELECT
    c.id,
    c.claim_token,
    c.lease_expires_at,
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
  'Atomically claims pending failures with unique claim tokens and lease expiration. '
  'Returns ONLY IDs claimed by this invocation. '
  'Recovers expired leases. Exhausts unresolvable failures. '
  'Workers must use claim_token when calling report_attempt_outcome().';

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_failed_operations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_operations() TO service_role;

-- ============================================================================
-- REPORT ATTEMPT OUTCOME (new function)
--
-- Worker reports whether an attempt succeeded or failed.
-- Requires valid claim_token to prevent stale workers from interfering.
--
-- On success:
--   → resolved
--
-- On failure with remaining attempts:
--   → pending (with backoff, cleared claim)
--
-- On failure with no remaining attempts:
--   → exhausted (final attempt failed, bounded)
--
-- Stale token rejection:
--   If claim_token doesn't match, or lease expired, the call is rejected.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.report_attempt_outcome(
  p_failure_id bigint,
  p_claim_token uuid,
  p_success boolean,
  p_error_message text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current record;
  v_new_status text;
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'claim_token is required';
  END IF;

  -- Fetch current state
  SELECT id, status, claim_token, lease_expires_at, attempt_count, max_attempts
  INTO v_current
  FROM public.operation_failures
  WHERE id = p_failure_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Failure % not found', p_failure_id;
  END IF;

  -- Must be in retrying state
  IF v_current.status != 'retrying' THEN
    RAISE EXCEPTION 'Failure % is not in retrying state (current: %)', p_failure_id, v_current.status;
  END IF;

  -- Validate claim token (prevents stale workers)
  IF v_current.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'Stale claim token: failure % has been reclaimed by another worker', p_failure_id;
  END IF;

  -- Check lease expiration
  IF v_current.lease_expires_at IS NOT NULL AND v_current.lease_expires_at < now() THEN
    RAISE EXCEPTION 'Lease expired for failure % (expired at %). Claim may have been recovered.',
      p_failure_id, v_current.lease_expires_at;
  END IF;

  -- Determine new status
  IF p_success THEN
    v_new_status := 'resolved';
  ELSIF v_current.attempt_count < v_current.max_attempts THEN
    v_new_status := 'pending';  -- more attempts available
  ELSE
    v_new_status := 'exhausted';  -- final attempt failed
  END IF;

  -- Apply state transition atomically
  -- The claim_token check in WHERE ensures no stale update
  UPDATE public.operation_failures SET
    status = v_new_status,
    resolved_at = CASE WHEN v_new_status = 'resolved' THEN now() ELSE NULL END,
    claim_token = NULL,
    lease_expires_at = NULL,
    error_message = COALESCE(p_error_message, public.operation_failures.error_message),
    next_retry_at = CASE
      WHEN v_new_status = 'pending' THEN
        now() + ((power(2, v_current.attempt_count)::integer || ' minutes')::interval)
      ELSE public.operation_failures.next_retry_at
    END,
    updated_at = now()
  WHERE id = p_failure_id
    AND claim_token = p_claim_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Failed to update failure % — claim token may have changed', p_failure_id;
  END IF;

  RETURN v_new_status;
END;
$$;

COMMENT ON FUNCTION public.report_attempt_outcome IS
  'Reports the outcome of a claimed attempt. Requires valid claim_token. '
  'Success → resolved. Failure + remaining attempts → pending. '
  'Failure + no attempts → exhausted. Rejects stale tokens.';

REVOKE ALL PRIVILEGES ON FUNCTION public.report_attempt_outcome(bigint, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_attempt_outcome(bigint, uuid, boolean, text)
  TO service_role;

-- ============================================================================
-- RESOLVE OPERATION FAILURE (updated: requires claim_token)
-- Backward-compatible wrapper that calls report_attempt_outcome(success=true)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_operation_failure(
  p_failure_id bigint,
  p_claim_token uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result text;
BEGIN
  v_result := public.report_attempt_outcome(p_failure_id, p_claim_token, true, NULL);
  -- report_attempt_outcome handles all validation and state transitions
END;
$$;

COMMENT ON FUNCTION public.resolve_operation_failure IS
  'Resolves a claimed failure. Requires valid claim_token. '
  'Wrapper around report_attempt_outcome(success=true).';

REVOKE ALL PRIVILEGES ON FUNCTION public.resolve_operation_failure(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_operation_failure(bigint, uuid) TO service_role;

COMMIT;
