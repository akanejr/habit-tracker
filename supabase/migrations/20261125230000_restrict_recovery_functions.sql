-- Migration: Restrict recovery function access to service_role only
-- SECURITY FIX: Recovery functions were accessible to PUBLIC by default
-- This migration revokes PUBLIC access and explicitly grants only to service_role

BEGIN;

-- Revoke EXECUTE from PUBLIC for all recovery functions
REVOKE EXECUTE ON FUNCTION public.record_incomplete_deletion FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.retry_incomplete_deletions FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_deletion_resolved FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.increment_deletion_attempt FROM PUBLIC;

-- Revoke from authenticated as well (only API routes with service_role should call these)
REVOKE EXECUTE ON FUNCTION public.record_incomplete_deletion FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.retry_incomplete_deletions FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_deletion_resolved FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_deletion_attempt FROM authenticated;

-- Grant to service_role only
GRANT EXECUTE ON FUNCTION public.record_incomplete_deletion TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_incomplete_deletions TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_deletion_resolved TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_deletion_attempt TO service_role;

-- Grant table permissions to service_role (BYPASSRLS bypasses RLS but not table permissions)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.incomplete_deletions TO service_role;
GRANT USAGE ON SEQUENCE incomplete_deletions_id_seq TO service_role;

COMMIT;
