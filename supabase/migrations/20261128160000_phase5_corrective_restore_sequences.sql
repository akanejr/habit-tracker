-- Phase 5 Corrective Migration 3: Restore Sequence Synchronization
--
-- The restore function uses OVERRIDING SYSTEM VALUE to insert historical
-- identity values. This does NOT advance the associated sequences.
-- After restore, the next normal INSERT would fail with a duplicate key error.
--
-- FIX: After all inserts, advance each affected sequence to
-- GREATEST(current sequence value, MAX(id) + 1) to prevent collisions.
--
-- AFFECTED IDENTITY COLUMNS:
--   habit_session_segments.id           → habit_session_segments_id_seq
--   habit_session_goal_versions.id      → habit_session_goal_versions_id_seq
--   session_command_requests.id         → session_command_requests_id_seq
--   incomplete_deletions.id             → incomplete_deletions_id_seq
--
-- This migration rewrites bloom_restore_user_data() to include sequence
-- synchronization at the end of the restore transaction.

BEGIN;

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
  v_max_id bigint;
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
  -- DELETE existing data (reverse FK order)
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

  -- 4. Habit versions (GENERATED ALWAYS AS IDENTITY)
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

  -- 5. Session command requests (GENERATED ALWAYS AS IDENTITY)
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

  -- 6. Incomplete deletions (GENERATED ALWAYS AS IDENTITY)
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

  -- 7. Habit sessions
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

  -- 8. Session segments (GENERATED ALWAYS AS IDENTITY)
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

  -- 9. Goal versions (GENERATED ALWAYS AS IDENTITY)
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

  -- ========================================================================
  -- SEQUENCE SYNCHRONIZATION
  -- Advance each identity sequence to at least MAX(id) + 1 to prevent
  -- duplicate key errors on subsequent normal inserts.
  -- Uses GREATEST to avoid setting sequence backwards.
  -- ========================================================================

  -- habit_session_segments_id_seq
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.habit_session_segments;
  PERFORM setval('public.habit_session_segments_id_seq',
    GREATEST(v_max_id, (SELECT last_value FROM public.habit_session_segments_id_seq)));

  -- habit_session_goal_versions_id_seq
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.habit_session_goal_versions;
  PERFORM setval('public.habit_session_goal_versions_id_seq',
    GREATEST(v_max_id, (SELECT last_value FROM public.habit_session_goal_versions_id_seq)));

  -- session_command_requests_id_seq
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.session_command_requests;
  PERFORM setval('public.session_command_requests_id_seq',
    GREATEST(v_max_id, (SELECT last_value FROM public.session_command_requests_id_seq)));

  -- incomplete_deletions_id_seq
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.incomplete_deletions;
  PERFORM setval('public.incomplete_deletions_id_seq',
    GREATEST(v_max_id, (SELECT last_value FROM public.incomplete_deletions_id_seq)));

  -- habit_versions_id_seq
  SELECT COALESCE(MAX(id), 0) INTO v_max_id FROM public.habit_versions;
  PERFORM setval('public.habit_versions_id_seq',
    GREATEST(v_max_id, (SELECT last_value FROM public.habit_versions_id_seq)));
END;
$$;

COMMENT ON FUNCTION public.bloom_restore_user_data IS
  'Restores user data from a snapshot with sequence synchronization. '
  'Service-role only. Requires p_target_user_id. '
  'After insert, advances all identity sequences past restored MAX(id) '
  'to prevent duplicate key errors on subsequent inserts.';

REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_restore_user_data(bigint, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_restore_user_data(bigint, uuid, boolean)
  TO service_role;

COMMIT;
