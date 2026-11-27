-- DOWN: Data Integrity Checks
-- REVERSIBILITY: Fully reversible — drops the read-only check function.
-- DATA LOSS: None. This function never modifies data.
-- NEVER execute this automatically. Manual review required before running.

BEGIN;

DROP FUNCTION IF EXISTS public.bloom_check_data_integrity() CASCADE;

COMMIT;
