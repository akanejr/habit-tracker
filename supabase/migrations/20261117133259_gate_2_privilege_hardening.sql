BEGIN;

REVOKE ALL PRIVILEGES
  ON TABLE public.profiles, public.habits, public.habit_logs
  FROM PUBLIC, anon, authenticated;

GRANT SELECT
  ON TABLE public.habits
  TO anon;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.profiles, public.habits, public.habit_logs
  TO authenticated;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.handle_updated_at()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;

COMMIT;
