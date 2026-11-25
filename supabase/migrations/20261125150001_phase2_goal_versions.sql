-- Phase 2: Goal Versioning
-- Creates habit_session_goal_versions table for tracking weekly session goals
-- Supports goal changes with historical preservation and effective dates

BEGIN;

-- ============================================================================
-- HABIT_SESSION_GOAL_VERSIONS TABLE
-- ============================================================================

CREATE TABLE public.habit_session_goal_versions (
  id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  habit_id uuid NOT NULL REFERENCES public.habits(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Goal definition
  effective_week date NOT NULL,
  weekly_session_target integer CHECK (weekly_session_target IS NULL OR weekly_session_target >= 1),
  goal_confirmed boolean NOT NULL DEFAULT false,
  
  -- Metadata
  recorded_at timestamptz NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT habit_session_goal_versions_unique_week UNIQUE (habit_id, effective_week),
  CONSTRAINT habit_session_goal_versions_monday CHECK (
    effective_week = public.lagos_week_start(effective_week)
  )
);

COMMENT ON TABLE public.habit_session_goal_versions IS 'Historical record of weekly session goals with effective dates';
COMMENT ON COLUMN public.habit_session_goal_versions.effective_week IS 'Monday (Africa/Lagos) when this goal takes effect';
COMMENT ON COLUMN public.habit_session_goal_versions.weekly_session_target IS 'Target sessions per week (NULL = no target, can exceed 7)';
COMMENT ON COLUMN public.habit_session_goal_versions.goal_confirmed IS 'Whether user has explicitly confirmed this goal';
COMMENT ON COLUMN public.habit_session_goal_versions.recorded_at IS 'When this version was created';

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX habit_session_goal_versions_habit_id_idx 
  ON public.habit_session_goal_versions(habit_id, effective_week DESC);

CREATE INDEX habit_session_goal_versions_user_id_idx 
  ON public.habit_session_goal_versions(user_id);

CREATE INDEX habit_session_goal_versions_effective_idx 
  ON public.habit_session_goal_versions(effective_week);

CREATE INDEX habit_session_goal_versions_active_idx 
  ON public.habit_session_goal_versions(habit_id, effective_week DESC)
  WHERE goal_confirmed = true;

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.habit_session_goal_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY habit_session_goal_versions_select_own ON public.habit_session_goal_versions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY habit_session_goal_versions_insert_own ON public.habit_session_goal_versions
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (
      SELECT 1 FROM public.habits
      WHERE habits.id = habit_session_goal_versions.habit_id
      AND habits.user_id = (SELECT auth.uid())
    )
  );

-- No UPDATE or DELETE policies - goal versions are immutable once created
-- To "change" a goal, create a new version with a later effective_week

-- ============================================================================
-- PRIVILEGES
-- ============================================================================

REVOKE ALL PRIVILEGES ON TABLE public.habit_session_goal_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.habit_session_goal_versions_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.habit_session_goal_versions TO authenticated;
GRANT USAGE ON SEQUENCE public.habit_session_goal_versions_id_seq TO authenticated;

-- ============================================================================
-- HELPER FUNCTION: Get active goal for a week
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_active_goal(
  p_habit_id uuid,
  p_week date
)
RETURNS TABLE (
  id bigint,
  weekly_session_target integer,
  goal_confirmed boolean,
  effective_week date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT 
    g.id,
    g.weekly_session_target,
    g.goal_confirmed,
    g.effective_week
  FROM public.habit_session_goal_versions g
  WHERE g.habit_id = p_habit_id
    AND g.effective_week <= p_week
    AND g.goal_confirmed = true
  ORDER BY g.effective_week DESC, g.id DESC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_active_goal IS 'Returns the active goal for a habit in a given week (most recent confirmed version)';

REVOKE ALL PRIVILEGES ON FUNCTION public.get_active_goal(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_goal(uuid, date) TO authenticated;

-- ============================================================================
-- MIGRATION: Initialize goals from existing habits
-- ============================================================================

-- For habits with target_per_week set, create an initial goal version
-- effective from the Monday of the week when the habit was created
INSERT INTO public.habit_session_goal_versions (
  habit_id,
  user_id,
  effective_week,
  weekly_session_target,
  goal_confirmed,
  recorded_at
)
SELECT 
  h.id,
  h.user_id,
  public.lagos_week_start(h.created_at::date),
  h.target_per_week,
  true, -- Assume existing targets were confirmed
  h.created_at
FROM public.habits h
WHERE h.target_per_week IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.habit_session_goal_versions g
    WHERE g.habit_id = h.id
  )
ON CONFLICT (habit_id, effective_week) DO NOTHING;

COMMIT;
