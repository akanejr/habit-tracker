-- DOWN: User Data Snapshots
-- REVERSIBILITY: Fully reversible — drops all Phase 5 snapshot infrastructure.
-- DATA LOSS WARNING: All existing snapshots will be permanently deleted.
-- NEVER execute this automatically. Manual review required before running.

BEGIN;

DROP FUNCTION IF EXISTS public.bloom_restore_user_data(bigint, boolean) CASCADE;
DROP FUNCTION IF EXISTS public.bloom_snapshot_user_data(text) CASCADE;

DROP POLICY IF EXISTS user_data_snapshots_select_own ON public.user_data_snapshots;
DROP POLICY IF EXISTS user_data_snapshots_insert_own ON public.user_data_snapshots;
DROP POLICY IF EXISTS user_data_snapshots_delete_own ON public.user_data_snapshots;

DROP TABLE IF EXISTS public.user_data_snapshots CASCADE;

COMMIT;
