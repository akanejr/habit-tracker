BEGIN;

LOCK TABLE public.habits IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.habit_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  habit_id uuid NOT NULL,
  user_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  is_baseline boolean NOT NULL DEFAULT false,
  name text NOT NULL,
  description text,
  frequency text NOT NULL,
  target_per_week integer,
  preferred_time time without time zone,
  color text,
  icon text,
  is_active boolean NOT NULL,
  FOREIGN KEY (habit_id, user_id)
    REFERENCES public.habits (id, user_id) ON DELETE CASCADE
);

CREATE INDEX habit_versions_owner_habit_time_idx
  ON public.habit_versions (user_id, habit_id, recorded_at, id);

ALTER TABLE public.habit_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY habit_versions_select_own ON public.habit_versions
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

REVOKE ALL PRIVILEGES ON TABLE public.habit_versions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.habit_versions TO authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.habit_versions_id_seq FROM PUBLIC, anon, authenticated;

INSERT INTO public.habit_versions
  (habit_id, user_id, is_baseline, name, description, frequency,
   target_per_week, preferred_time, color, icon, is_active)
SELECT id, user_id, true, name, description, frequency,
       target_per_week, preferred_time, color, icon, is_active
FROM public.habits;

CREATE FUNCTION public.record_habit_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.habit_versions
    (habit_id, user_id, name, description, frequency, target_per_week,
     preferred_time, color, icon, is_active)
  VALUES
    (NEW.id, NEW.user_id, NEW.name, NEW.description, NEW.frequency,
     NEW.target_per_week, NEW.preferred_time, NEW.color, NEW.icon, NEW.is_active);
  RETURN NEW;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.record_habit_version() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER on_habit_version_changed
  AFTER INSERT OR UPDATE ON public.habits
  FOR EACH ROW EXECUTE FUNCTION public.record_habit_version();

COMMIT;
