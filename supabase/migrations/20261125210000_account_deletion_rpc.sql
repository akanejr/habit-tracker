-- Migration: Account deletion RPC function
-- Date: 2026-11-25
-- Purpose: Implement secure account deletion with complete data cleanup
-- Phase: 3 (Security, Authentication and Account Deletion)

BEGIN;

-- ============================================================================
-- ACCOUNT DELETION FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.delete_user_account(
  p_confirmation_text text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_deleted_counts jsonb := '{}'::jsonb;
  v_total_deleted integer := 0;
BEGIN
  -- Get authenticated user
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Require explicit confirmation
  IF p_confirmation_text IS DISTINCT FROM 'DELETE' THEN
    RAISE EXCEPTION 'Confirmation text must be "DELETE"';
  END IF;

  -- Verify user exists
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;

  -- ========================================================================
  -- DELETE USER DATA (in correct order to respect foreign keys)
  -- ========================================================================

  -- 1. Delete session_command_requests (no foreign keys)
  WITH deleted AS (
    DELETE FROM public.session_command_requests
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'session_command_requests' FROM deleted;

  -- 2. Delete habit_session_goal_versions (depends on habit_sessions)
  WITH deleted AS (
    DELETE FROM public.habit_session_goal_versions
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'habit_session_goal_versions' FROM deleted;

  -- 3. Delete habit_session_segments (depends on habit_sessions)
  WITH deleted AS (
    DELETE FROM public.habit_session_segments
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'habit_session_segments' FROM deleted;

  -- 4. Delete habit_sessions (depends on habits, habit_versions)
  WITH deleted AS (
    DELETE FROM public.habit_sessions
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'habit_sessions' FROM deleted;

  -- 5. Delete habit_logs (depends on habits)
  WITH deleted AS (
    DELETE FROM public.habit_logs
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'habit_logs' FROM deleted;

  -- 6. Delete habit_versions (depends on habits)
  WITH deleted AS (
    DELETE FROM public.habit_versions
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'habit_versions' FROM deleted;

  -- 7. Delete habits (depends on profiles)
  WITH deleted AS (
    DELETE FROM public.habits
    WHERE user_id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'habits' FROM deleted;

  -- 8. Delete profile (depends on auth.users)
  WITH deleted AS (
    DELETE FROM public.profiles
    WHERE id = v_user_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted_counts->>'profiles' FROM deleted;

  -- Calculate total deleted
  SELECT SUM((v_deleted_counts->>key)::integer)
  INTO v_total_deleted
  FROM jsonb_object_keys(v_deleted_counts) AS key;

  -- Note: auth.users deletion must be handled by application code
  -- using Supabase Admin API (requires service role key)
  -- This function only deletes application data

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_user_id,
    'deleted_counts', v_deleted_counts,
    'total_deleted', v_total_deleted,
    'message', 'Account data deleted successfully. Auth account deletion pending.'
  );
END;
$$;

COMMENT ON FUNCTION public.delete_user_account IS
  'Securely deletes all user data from the application database. '
  'Requires explicit confirmation text "DELETE". '
  'Does not delete auth.users record (handled by application code via Supabase Admin API). '
  'Returns counts of deleted records for audit purposes.';

-- ============================================================================
-- GRANT PERMISSIONS
-- ============================================================================

-- Allow authenticated users to call this function
GRANT EXECUTE ON FUNCTION public.delete_user_account TO authenticated;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Verify function exists and is SECURITY DEFINER
DO $$
DECLARE
  v_is_secdef boolean;
BEGIN
  SELECT prosecdef INTO v_is_secdef
  FROM pg_proc
  WHERE proname = 'delete_user_account'
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
  
  IF NOT v_is_secdef THEN
    RAISE EXCEPTION 'delete_user_account is not SECURITY DEFINER';
  END IF;
  
  RAISE NOTICE 'delete_user_account function created successfully with SECURITY DEFINER';
END $$;

COMMIT;
