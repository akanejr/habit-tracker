-- Fix session_goal_type CHECK constraint
-- The original constraint using IN ('none', 'weekly', NULL) doesn't work correctly
-- because NULL comparisons with = always return NULL, not true/false

BEGIN;

-- Drop the broken constraint
ALTER TABLE public.habits 
DROP CONSTRAINT IF EXISTS habits_session_goal_type_check;

-- Add the correct constraint that properly handles NULL
ALTER TABLE public.habits 
ADD CONSTRAINT habits_session_goal_type_check 
CHECK (session_goal_type IS NULL OR session_goal_type IN ('none', 'weekly'));

COMMENT ON CONSTRAINT habits_session_goal_type_check ON public.habits IS 
'session_goal_type must be NULL, "none", or "weekly"';

COMMIT;
