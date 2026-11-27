-- DOWN: Operation Failure Log
-- REVERSIBILITY: Fully reversible — drops all Phase 5 failure tracking infrastructure.
-- DATA LOSS WARNING: All existing operation failure records will be permanently deleted.
--   If any failures were being tracked for retry, those retries will no longer occur.
-- NEVER execute this automatically. Manual review required before running.

BEGIN;

DROP FUNCTION IF EXISTS public.resolve_operation_failure(bigint) CASCADE;
DROP FUNCTION IF EXISTS public.retry_failed_operations() CASCADE;
DROP FUNCTION IF EXISTS public.record_operation_failure(text, jsonb, text, boolean, integer) CASCADE;

DROP POLICY IF EXISTS operation_failures_select_own ON public.operation_failures;
DROP POLICY IF EXISTS operation_failures_insert_own ON public.operation_failures;

DROP TABLE IF EXISTS public.operation_failures CASCADE;

COMMIT;
