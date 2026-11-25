-- Migration: Account deletion RPC function
BEGIN;

CREATE OR REPLACE FUNCTION public.delete_user_account(p_confirmation_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_confirmation_text != '
    RAISE EXCEPTION 'Invalid confirmation';
  END IF;

  DELETE FROM public.session_command_requests WHERE user_id = v_user_id;
  DELETE FROM public.habit_session_goal_versions WHERE user_id = v_user_id;
  DELETE FROM public.habit_session_segments WHERE user_id = v_user_id;
  DELETE FROM public.habit_sessions WHERE user_id = v_user_id;
  DELETE FROM public.habit_logs WHERE user_id = v_user_id;
  DELETE FROM public.habit_versions WHERE user_id = v_user_id;
  DELETE FROM public.habits WHERE user_id = v_user_id;
  DELETE FROM public.profiles WHERE id = v_user_id;

  RETURN jsonb_build_object('success', true, 'message', 'Account deleted');
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_user_account TO authenticated;
COMMIT;
