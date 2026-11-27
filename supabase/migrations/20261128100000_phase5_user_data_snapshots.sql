-- Phase 5: User Data Snapshots (Backup & Restore)
-- Creates snapshot table and RPC functions for full user data backup/restore.
--
-- SNAPSHOT COVERAGE (9 tables):
--   profiles, habits, habit_logs, habit_sessions, habit_session_segments,
--   habit_session_goal_versions, habit_versions, session_command_requests,
--   incomplete_deletions
--
-- EXCLUDED (not user data or self-referential):
--   user_data_snapshots (this table), operation_failures (Phase 5 metadata)
--
-- RESTORE SAFETY:
--   - Validates snapshot ownership before restoring
--   - Respects foreign-key ordering (delete children first, insert parents first)
--   - Errors if newer data exists unless p_force = true (service_role only)
--   - Idempotent: restoring the same snapshot twice produces the same result
--   - Restore function is SECURITY DEFINER restricted to service_role

BEGIN;

-- ============================================================================
-- USER_DATA_SNAPSHOTS TABLE
-- ============================================================================

CREATE TABLE public.user_data_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  snapshot_data jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.user_data_snapshots IS
  'Point-in-time snapshots of all user-owned data for backup and recovery';
COMMENT ON COLUMN public.user_data_snapshots.reason IS
  'Why this snapshot was taken (e.g. pre-deletion, pre-migration, manual)';

-- Indexes
CREATE INDEX user_data_snapshots_user_id_idx
  ON public.user_data_snapshots(user_id, created_at DESC);

-- RLS
ALTER TABLE public.user_data_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_data_snapshots_select_own ON public.user_data_snapshots
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY user_data_snapshots_insert_own ON public.user_data_snapshots
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY user_data_snapshots_delete_own ON public.user_data_snapshots
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- No UPDATE policy — snapshots are immutable once created

-- Privileges
REVOKE ALL PRIVILEGES ON TABLE public.user_data_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.user_data_snapshots_id_seq FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.user_data_snapshots TO authenticated;
GRANT USAGE ON SEQUENCE public.user_data_snapshots_id_seq TO authenticated;

-- ============================================================================
-- SNAPSHOT FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bloom_snapshot_user_data(p_reason text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_data jsonb;
  v_snapshot_id bigint;
BEGIN
  -- Auth check
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'Snapshot reason is required';
  END IF;

  -- Build complete JSONB snapshot of all 9 user-owned tables
  SELECT jsonb_build_object(
    'snapshot_version', 1,
    'captured_at', now(),

    'profiles', COALESCE(
      (SELECT jsonb_agg(row_to_json(p)::jsonb)
       FROM public.profiles p WHERE p.id = v_user_id),
      '[]'::jsonb),

    'habits', COALESCE(
      (SELECT jsonb_agg(row_to_json(h)::jsonb ORDER BY h.created_at)
       FROM public.habits h WHERE h.user_id = v_user_id),
      '[]'::jsonb),

    'habit_logs', COALESCE(
      (SELECT jsonb_agg(row_to_json(hl)::jsonb ORDER BY hl.completed_on)
       FROM public.habit_logs hl WHERE hl.user_id = v_user_id),
      '[]'::jsonb),

    'habit_sessions', COALESCE(
      (SELECT jsonb_agg(row_to_json(hs)::jsonb ORDER BY hs.created_at)
       FROM public.habit_sessions hs WHERE hs.user_id = v_user_id),
      '[]'::jsonb),

    'habit_session_segments', COALESCE(
      (SELECT jsonb_agg(row_to_json(seg)::jsonb ORDER BY seg.started_at)
       FROM public.habit_session_segments seg WHERE seg.user_id = v_user_id),
      '[]'::jsonb),

    'habit_session_goal_versions', COALESCE(
      (SELECT jsonb_agg(row_to_json(gv)::jsonb ORDER BY gv.effective_week)
       FROM public.habit_session_goal_versions gv WHERE gv.user_id = v_user_id),
      '[]'::jsonb),

    'habit_versions', COALESCE(
      (SELECT jsonb_agg(row_to_json(hv)::jsonb ORDER BY hv.recorded_at)
       FROM public.habit_versions hv WHERE hv.user_id = v_user_id),
      '[]'::jsonb),

    'session_command_requests', COALESCE(
      (SELECT jsonb_agg(row_to_json(scr)::jsonb ORDER BY scr.created_at)
       FROM public.session_command_requests scr WHERE scr.user_id = v_user_id),
      '[]'::jsonb),

    'incomplete_deletions', COALESCE(
      (SELECT jsonb_agg(row_to_json(idel)::jsonb ORDER BY idel.created_at)
       FROM public.incomplete_deletions idel WHERE idel.user_id = v_user_id),
      '[]'::jsonb)
  ) INTO v_data;

  -- Insert snapshot
  INSERT INTO public.user_data_snapshots (user_id, snapshot_data, reason)
  VALUES (v_user_id, v_data, p_reason)
  RETURNING id INTO v_snapshot_id;

  RETURN v_snapshot_id;
END;
$$;

COMMENT ON FUNCTION public.bloom_snapshot_user_data IS
  'Captures a complete snapshot of the authenticated user''s data across all 9 tables';

REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_snapshot_user_data(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_snapshot_user_data(text) TO authenticated;

-- ============================================================================
-- RESTORE FUNCTION (service_role only)
--
-- AUTHORIZATION DESIGN:
--   - EXECUTE is granted ONLY to service_role (revoked from authenticated/PUBLIC)
--   - Does NOT rely on auth.uid() — service_role requests have no user JWT
--   - Caller must provide p_target_user_id explicitly
--   - Validates snapshot belongs to p_target_user_id before restoring
--   - p_force controls whether existing data is overwritten
--
-- In a real deployment, this function is called from trusted server-side code
-- (API routes, Edge Functions) that authenticates with the service_role key.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bloom_restore_user_data(
  p_snapshot_id bigint,
  p_target_user_id uuid,
  p_force boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_snapshot record;
  v_current_count integer;
  v_item jsonb;
BEGIN
  -- Validate inputs
  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'p_target_user_id is required';
  END IF;

  -- Fetch snapshot
  SELECT id, user_id, snapshot_data, created_at
  INTO v_snapshot
  FROM public.user_data_snapshots
  WHERE id = p_snapshot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Snapshot % not found', p_snapshot_id;
  END IF;

  -- Validate snapshot belongs to the target user
  IF v_snapshot.user_id != p_target_user_id THEN
    RAISE EXCEPTION 'Access denied: snapshot % belongs to user %, not target user %',
      p_snapshot_id, v_snapshot.user_id, p_target_user_id;
  END IF;

  -- Safety check: error if current data exists and p_force is false
  IF NOT p_force THEN
    SELECT COUNT(*) INTO v_current_count
    FROM public.habits
    WHERE user_id = p_target_user_id;

    IF v_current_count > 0 THEN
      RAISE EXCEPTION
        'Target user has % existing habits. Set p_force = true to overwrite. '
        'Snapshot was taken at %.',
        v_current_count, v_snapshot.created_at;
    END IF;
  END IF;

  -- ========================================================================
  -- DELETE existing data (reverse FK order to avoid constraint violations)
  -- ========================================================================
  DELETE FROM public.session_command_requests WHERE user_id = p_target_user_id;
  DELETE FROM public.habit_session_goal_versions WHERE user_id = p_target_user_id;
  DELETE FROM public.habit_sessions WHERE user_id = p_target_user_id;
  DELETE FROM public.habit_versions WHERE user_id = p_target_user_id;
  DELETE FROM public.incomplete_deletions WHERE user_id = p_target_user_id;
  DELETE FROM public.habit_logs WHERE user_id = p_target_user_id;
  DELETE FROM public.habits WHERE user_id = p_target_user_id;
  DELETE FROM public.profiles WHERE id = p_target_user_id;

  -- ========================================================================
  -- INSERT from snapshot (FK order: parents first)
  -- ========================================================================

  -- 1. Profiles
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'profiles')
  LOOP
    INSERT INTO public.profiles (id, display_name, avatar_url, created_at, updated_at)
    VALUES (
      (v_item->>'id')::uuid,
      v_item->>'display_name',
      v_item->>'avatar_url',
      COALESCE((v_item->>'created_at')::timestamptz, now()),
      COALESCE((v_item->>'updated_at')::timestamptz, now())
    );
  END LOOP;

  -- 2. Habits
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'habits')
  LOOP
    INSERT INTO public.habits (
      id, user_id, name, description, frequency, target_per_week,
      color, icon, is_active, created_at, updated_at
    ) VALUES (
      (v_item->>'id')::uuid,
      (v_item->>'user_id')::uuid,
      v_item->>'name',
      v_item->>'description',
      v_item->>'frequency',
      (v_item->>'target_per_week')::integer,
      v_item->>'color',
      v_item->>'icon',
      COALESCE((v_item->>'is_active')::boolean, true),
      COALESCE((v_item->>'created_at')::timestamptz, now()),
      COALESCE((v_item->>'updated_at')::timestamptz, now())
    );
  END LOOP;

  -- 3. Habit logs
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'habit_logs')
  LOOP
    INSERT INTO public.habit_logs (id, habit_id, user_id, completed_on, note, created_at)
    VALUES (
      (v_item->>'id')::uuid,
      (v_item->>'habit_id')::uuid,
      (v_item->>'user_id')::uuid,
      (v_item->>'completed_on')::date,
      v_item->>'note',
      COALESCE((v_item->>'created_at')::timestamptz, now())
    );
  END LOOP;

  -- 4. Habit versions (has GENERATED ALWAYS AS IDENTITY — use OVERRIDING SYSTEM VALUE)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'habit_versions')
  LOOP
    INSERT INTO public.habit_versions (
      id, habit_id, user_id, recorded_at, is_baseline,
      name, description, frequency, target_per_week,
      preferred_time, color, icon, is_active
    ) OVERRIDING SYSTEM VALUE VALUES (
      (v_item->>'id')::bigint,
      (v_item->>'habit_id')::uuid,
      (v_item->>'user_id')::uuid,
      COALESCE((v_item->>'recorded_at')::timestamptz, now()),
      COALESCE((v_item->>'is_baseline')::boolean, false),
      v_item->>'name',
      v_item->>'description',
      v_item->>'frequency',
      (v_item->>'target_per_week')::integer,
      (v_item->>'preferred_time')::time,
      v_item->>'color',
      v_item->>'icon',
      COALESCE((v_item->>'is_active')::boolean, true)
    );
  END LOOP;

  -- 5. Session command requests (has GENERATED ALWAYS AS IDENTITY)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'session_command_requests')
  LOOP
    INSERT INTO public.session_command_requests (
      id, request_id, user_id, operation_type,
      operation_payload, operation_result, processed_at, created_at
    ) OVERRIDING SYSTEM VALUE VALUES (
      (v_item->>'id')::bigint,
      v_item->>'request_id',
      (v_item->>'user_id')::uuid,
      v_item->>'operation_type',
      COALESCE((v_item->>'operation_payload')::jsonb, '{}'::jsonb),
      (v_item->>'operation_result')::jsonb,
      COALESCE((v_item->>'processed_at')::timestamptz, now()),
      COALESCE((v_item->>'created_at')::timestamptz, now())
    );
  END LOOP;

  -- 6. Incomplete deletions (has GENERATED ALWAYS AS IDENTITY)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'incomplete_deletions')
  LOOP
    INSERT INTO public.incomplete_deletions (
      id, user_id, user_email, database_deleted_at,
      auth_deletion_attempts, last_attempt_at, last_error,
      resolved, resolved_at, created_at
    ) OVERRIDING SYSTEM VALUE VALUES (
      (v_item->>'id')::bigint,
      (v_item->>'user_id')::uuid,
      v_item->>'user_email',
      COALESCE((v_item->>'database_deleted_at')::timestamptz, now()),
      COALESCE((v_item->>'auth_deletion_attempts')::integer, 1),
      COALESCE((v_item->>'last_attempt_at')::timestamptz, now()),
      v_item->>'last_error',
      COALESCE((v_item->>'resolved')::boolean, false),
      (v_item->>'resolved_at')::timestamptz,
      COALESCE((v_item->>'created_at')::timestamptz, now())
    );
  END LOOP;

  -- 7. Habit sessions (children of habits)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'habit_sessions')
  LOOP
    INSERT INTO public.habit_sessions (
      id, user_id, habit_id, source, status, recording_mode,
      completed_on, duration_ms, estimated_ms, note,
      started_at, completed_at, created_at,
      start_version_id, completion_version_id, legacy_log_id
    ) VALUES (
      (v_item->>'id')::uuid,
      (v_item->>'user_id')::uuid,
      (v_item->>'habit_id')::uuid,
      v_item->>'source',
      v_item->>'status',
      v_item->>'recording_mode',
      (v_item->>'completed_on')::date,
      (v_item->>'duration_ms')::bigint,
      (v_item->>'estimated_ms')::bigint,
      v_item->>'note',
      (v_item->>'started_at')::timestamptz,
      (v_item->>'completed_at')::timestamptz,
      COALESCE((v_item->>'created_at')::timestamptz, now()),
      (v_item->>'start_version_id')::bigint,
      (v_item->>'completion_version_id')::bigint,
      (v_item->>'legacy_log_id')::uuid
    );
  END LOOP;

  -- 8. Session segments (children of sessions, has GENERATED ALWAYS AS IDENTITY)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'habit_session_segments')
  LOOP
    INSERT INTO public.habit_session_segments (
      id, session_id, user_id, started_at, ended_at, created_at
    ) OVERRIDING SYSTEM VALUE VALUES (
      (v_item->>'id')::bigint,
      (v_item->>'session_id')::uuid,
      (v_item->>'user_id')::uuid,
      COALESCE((v_item->>'started_at')::timestamptz, now()),
      (v_item->>'ended_at')::timestamptz,
      COALESCE((v_item->>'created_at')::timestamptz, now())
    );
  END LOOP;

  -- 9. Goal versions (children of habits, has GENERATED ALWAYS AS IDENTITY)
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_snapshot.snapshot_data->'habit_session_goal_versions')
  LOOP
    INSERT INTO public.habit_session_goal_versions (
      id, habit_id, user_id, effective_week,
      weekly_session_target, goal_confirmed, recorded_at
    ) OVERRIDING SYSTEM VALUE VALUES (
      (v_item->>'id')::bigint,
      (v_item->>'habit_id')::uuid,
      (v_item->>'user_id')::uuid,
      (v_item->>'effective_week')::date,
      (v_item->>'weekly_session_target')::integer,
      COALESCE((v_item->>'goal_confirmed')::boolean, false),
      COALESCE((v_item->>'recorded_at')::timestamptz, now())
    );
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.bloom_restore_user_data IS
  'Restores user data from a snapshot. Service-role only. '
  'Caller must provide p_target_user_id explicitly (no auth.uid() dependency). '
  'Validates snapshot belongs to target user. Respects FK ordering. '
  'Errors if existing data found unless p_force = true.';

-- Restore is privileged: revoke from regular users, grant explicitly to service_role
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_restore_user_data(bigint, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_restore_user_data(bigint, uuid, boolean)
  TO service_role;

COMMIT;
