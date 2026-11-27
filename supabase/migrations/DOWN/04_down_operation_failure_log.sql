-- DOWN: Operation Failure Log (corrected for current signatures)
-- DATA LOSS: All operation failure records permanently deleted.
-- NEVER execute automatically.

BEGIN;

DROP FUNCTION IF EXISTS public.resolve_operation_failure(bigint, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.resolve_operation_failure(bigint) CASCADE;
DROP FUNCTION IF EXISTS public.report_attempt_outcome(bigint, uuid, boolean, text) CASCADE;
DROP FUNCTION IF EXISTS public.retry_failed_operations() CASCADE;
DROP FUNCTION IF EXISTS public.record_operation_failure(text, jsonb, text, boolean, integer) CASCADE;

DROP POLICY IF EXISTS operation_failures_select_own ON public.operation_failures;
DROP POLICY IF EXISTS operation_failures_insert_own ON public.operation_failures;

DROP TABLE IF EXISTS public.operation_failures CASCADE;

COMMIT;
