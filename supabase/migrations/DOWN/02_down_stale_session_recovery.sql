-- DOWN: Stale Session Recovery
-- REVERSIBILITY: Fully reversible — drops the cleanup function.
-- DATA LOSS WARNING: Any sessions previously marked 'cancelled' with
--   note 'Auto-recovered: stale session' remain cancelled. Their estimated_ms
--   values are preserved but cannot be automatically reversed to 'running'.
-- NEVER execute this automatically. Manual review required before running.

BEGIN;

DROP FUNCTION IF EXISTS public.bloom_cleanup_stale_sessions() CASCADE;

COMMIT;
