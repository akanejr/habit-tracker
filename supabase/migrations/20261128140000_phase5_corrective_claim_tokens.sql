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
CREATE INDEX IF NOT EXISTS operation_failures_lease_idx
  ON public.operation_failures (lease_expires_at)
  WHERE status = 'retrying' AND lease_expires_at IS NOT NULL;

-- Drop old functions whose signatures/return types are changing
DROP FUNCTION IF EXISTS public.retry_failed_operations() CASCADE;
DROP FUNCTION IF EXISTS public.resolve_operation_failure(bigint) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_operation_failure(bigint, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.report_attempt_outcome(bigint, uuid, boolean, text) CASCADE;

-- ============================================================================
-- RETRY FAILED OPERATIONS (with claim tokens)
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
  -- STEP 1a: Recover expired NON-FINAL leases → pending (reclaimable)
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'pending',
    claim_token = NULL,
    lease_expires_at = NULL,
    next_retry_at = now(),
    updated_at = now()
  WHERE status = 'retrying'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now()
    AND attempt_count < max_attempts;

  -- ========================================================================
  -- STEP 1b: Expired FINAL leases → exhausted (bounded)
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'exhausted',
    claim_token = NULL,
    lease_expires_at = NULL,
    resolved_at = now(),
    updated_at = now()
  WHERE status = 'retrying'
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at < now()
    AND attempt_count >= max_attempts;

  -- ========================================================================
  -- STEP 2: Defensive exhaustion — active retrying rows that exceeded max
  -- ========================================================================
  UPDATE public.operation_failures SET
    status = 'exhausted',
    claim_token = NULL,
    lease_expires_at = NULL,
    resolved_at = now(),
    updated_at = now()
  WHERE status = 'retrying'
    AND attempt_count >= max_attempts
    AND (lease_expires_at IS NULL OR lease_expires_at < now());

  -- ========================================================================
  -- STEP 3: Claim pending rows with FOR UPDATE SKIP LOCKED
  -- ========================================================================
  RETURN QUERY
  WITH claimed AS (
    SELECT f2.id FROM public.operation_failures f2
    WHERE f2.status = 'pending'
      AND f2.next_retry_at <= now()
      AND f2.auto_retryable = true
      AND f2.attempt_count < f2.max_attempts
    ORDER BY f2.next_retry_at ASC
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.operation_failures AS f SET
    status = 'retrying',
    attempt_count = f.attempt_count + 1,
    claim_token = gen_random_uuid(),
    lease_expires_at = now() + v_lease_duration,
    next_retry_at = now() + v_lease_duration,
    updated_at = now()
  FROM claimed c
  WHERE f.id = c.id
  RETURNING
    f.id,
    f.claim_token,
    f.lease_expires_at,
    f.user_id,
    f.operation_type,
    f.payload,
    f.attempt_count,
    f.max_attempts,
    f.error_message;
END;
$$;

COMMENT ON FUNCTION public.retry_failed_operations IS
  'Claims pending failures and delivers them to workers with claim tokens. '
  'Recovers expired non-final leases (→ pending), exhausts expired final leases (→ exhausted), '
  'and claims pending rows with FOR UPDATE SKIP LOCKED for safe concurrency. '
  'Returns: failure_id, claim_token, lease_expires_at, user_id, operation_type, '
  'payload, attempt_count, max_attempts, error_message';

REVOKE ALL PRIVILEGES ON FUNCTION public.retry_failed_operations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_failed_operations() TO service_role;

-- ============================================================================
-- REPORT ATTEMPT OUTCOME (atomic state transition)
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
  v_result text;
  v_row_count integer;
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'claim_token is required';
  END IF;

  -- ====================================================================
  -- ATOMIC STATE TRANSITION
  -- Single UPDATE validates ALL conditions in the WHERE clause:
  --   1. Correct failure ID
  --   2. Status is 'retrying'
  --   3. Claim token matches (prevents stale worker)
  --   4. Lease has not expired (prevents post-expiry reporting)
  -- ====================================================================
  UPDATE public.operation_failures SET
    status = CASE
      WHEN p_success THEN 'resolved'
      WHEN attempt_count < max_attempts THEN 'pending'
      ELSE 'exhausted'
    END,
    resolved_at = CASE WHEN p_success THEN now() ELSE NULL END,
    claim_token = NULL,
    lease_expires_at = NULL,
    error_message = COALESCE(p_error_message, public.operation_failures.error_message),
    next_retry_at = CASE
      WHEN NOT p_success AND attempt_count < max_attempts THEN
        now() + ((power(2, attempt_count)::integer || ' minutes')::interval)
      ELSE public.operation_failures.next_retry_at
    END,
    updated_at = now()
  WHERE id = p_failure_id
    AND status = 'retrying'
    AND claim_token = p_claim_token
    AND (lease_expires_at IS NULL OR lease_expires_at >= now());

  GET DIAGNOSTICS v_row_count = ROW_COUNT;

  IF v_row_count = 0 THEN
    -- Determine specific rejection reason
    SELECT
      CASE
        WHEN f.id IS NULL THEN 'not_found'
        WHEN f.status != 'retrying' THEN 'not_retrying:' || f.status
        WHEN f.claim_token IS DISTINCT FROM p_claim_token THEN 'stale_token'
        WHEN f.lease_expires_at IS NOT NULL AND f.lease_expires_at < now() THEN 'lease_expired'
        ELSE 'unknown'
      END
    INTO v_result
    FROM public.operation_failures f
    WHERE f.id = p_failure_id;

    IF v_result IS NULL THEN
      RAISE EXCEPTION 'Failure % not found', p_failure_id;
    ELSIF v_result = 'not_retrying:resolved' THEN
      RAISE EXCEPTION 'Failure % already resolved', p_failure_id;
    ELSIF v_result = 'not_retrying:exhausted' THEN
      RAISE EXCEPTION 'Failure % already exhausted', p_failure_id;
    ELSIF v_result LIKE 'not_retrying:%' THEN
      RAISE EXCEPTION 'Failure % is not in retrying state (current: %)',
        p_failure_id, split_part(v_result, ':', 2);
    ELSIF v_result = 'stale_token' THEN
      RAISE EXCEPTION 'Stale claim token for failure % — reclaimed by another worker', p_failure_id;
    ELSIF v_result = 'lease_expired' THEN
      RAISE EXCEPTION 'Lease expired for failure % — claim may have been recovered', p_failure_id;
    ELSE
      RAISE EXCEPTION 'Cannot report outcome for failure % (%)', p_failure_id, v_result;
    END IF;
  END IF;

  -- Read back the new status
  SELECT status INTO v_result
  FROM public.operation_failures
  WHERE id = p_failure_id;

  RETURN v_result;
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
END;
$$;

COMMENT ON FUNCTION public.resolve_operation_failure IS
  'Resolves a claimed failure. Requires valid claim_token. '
  'Wrapper around report_attempt_outcome(success=true).';

REVOKE ALL PRIVILEGES ON FUNCTION public.resolve_operation_failure(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_operation_failure(bigint, uuid) TO service_role;

COMMIT;
