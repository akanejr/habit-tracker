-- Migration: Strengthen INSERT RLS policies
-- Date: 2026-11-25
-- Purpose: Add WITH CHECK clauses to INSERT policies to prevent cross-user data insertion
-- Phase: 3 (Security, Authentication and Account Deletion)

BEGIN;

-- ============================================================================
-- PROFILES TABLE
-- ============================================================================

-- Drop existing INSERT policy
DROP POLICY IF EXISTS profiles_insert_own ON public.profiles;

-- Create new INSERT policy WITH CHECK
-- Users can only insert their own profile (id must match auth.uid())
CREATE POLICY profiles_insert_own ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- ============================================================================
-- HABITS TABLE
-- ============================================================================

-- Drop existing INSERT policy
DROP POLICY IF EXISTS habits_insert_own ON public.habits;

-- Create new INSERT policy WITH CHECK
-- Users can only insert habits for themselves
CREATE POLICY habits_insert_own ON public.habits
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- HABIT_LOGS TABLE
-- ============================================================================

-- Drop existing INSERT policy
DROP POLICY IF EXISTS habit_logs_insert_own ON public.habit_logs;

-- Create new INSERT policy WITH CHECK
-- Users can only insert logs for themselves
CREATE POLICY habit_logs_insert_own ON public.habit_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- HABIT_SESSIONS TABLE (Phase 2)
-- ============================================================================

-- Drop existing INSERT policy
DROP POLICY IF EXISTS habit_sessions_insert_own ON public.habit_sessions;

-- Create new INSERT policy WITH CHECK
-- Users can only insert sessions for themselves
CREATE POLICY habit_sessions_insert_own ON public.habit_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- HABIT_SESSION_SEGMENTS TABLE (Phase 2)
-- ============================================================================

-- Drop existing INSERT policy
DROP POLICY IF EXISTS habit_session_segments_insert_own ON public.habit_session_segments;

-- Create new INSERT policy WITH CHECK
-- Users can only insert segments for themselves
CREATE POLICY habit_session_segments_insert_own ON public.habit_session_segments
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- HABIT_SESSION_GOAL_VERSIONS TABLE (Phase 2)
-- ============================================================================

-- Drop existing INSERT policy
DROP POLICY IF EXISTS habit_session_goal_versions_insert_own ON public.habit_session_goal_versions;

-- Create new INSERT policy WITH CHECK
-- Users can only insert goal versions for themselves
CREATE POLICY habit_session_goal_versions_insert_own ON public.habit_session_goal_versions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- VERIFICATION
-- ============================================================================

-- Verify all INSERT policies have WITH CHECK clauses
DO $$
DECLARE
  v_policy_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND cmd = 'INSERT'
    AND (with_check IS NULL OR with_check = '');
  
  IF v_policy_count > 0 THEN
    RAISE EXCEPTION 'Found % INSERT policies without WITH CHECK clause', v_policy_count;
  END IF;
  
  RAISE NOTICE 'All INSERT policies have WITH CHECK clauses';
END $$;

COMMIT;
