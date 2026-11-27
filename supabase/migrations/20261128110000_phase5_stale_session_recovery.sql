-- Phase 5: Stale Session Recovery
-- Detects and recovers sessions abandoned for more than 2 hours.
--
-- BEHAVIOR:
--   - Finds sessions in 'running' or 'paused' state with no activity > 2 hours
--   - Calculates total accumulated duration from ALL segments (preserves progress)
--   - Closes any open segments (sets ended_at for running sessions)
--   - Marks session as 'cancelled' with reason 'stale_auto_timeout'
--   - Sets estimated_ms to total accumulated time (never discards progress)
--   - Returns count of recovered sessions
--
-- THRESHOLD: 2 hours (120 minutes), defined as an explicit constant.
--            Sessions at or below this threshold are not touched.
--
-- INTEGRATION: Can be called on user login or periodically via cron.
--              Does NOT run automatically (no trigger or cron in this migration).

BEGIN;

-- ============================================================================
-- STALE SESSION CLEANUP FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bloom_cleanup_stale_sessions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer := 0;
  v_stale_threshold interval := interval '2 hours';
  v_user_id uuid;
  v_session record;
  v_total_ms bigint;
BEGIN
  -- SECURITY: Restrict to caller's own sessions only
  v_user_id := (SELECT auth.uid());
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Find stale sessions: active (running/paused) with last activity > threshold ago
  -- CRITICAL: Filtered to caller's own sessions only (v_user_id)
  FOR v_session IN
    SELECT
      hs.id,
      hs.status,
      MAX(seg.ended_at) AS last_ended,
      MAX(seg.started_at) AS last_started
    FROM public.habit_sessions hs
    JOIN public.habit_session_segments seg ON seg.session_id = hs.id
    WHERE hs.status IN ('running', 'paused')
      AND hs.user_id = v_user_id
    GROUP BY hs.id, hs.status
    HAVING (
      -- Running session: open segment started > threshold ago
      (hs.status = 'running'
       AND MAX(seg.ended_at) IS NULL
       AND MAX(seg.started_at) < now() - v_stale_threshold)
      OR
      -- Paused session: last segment ended > threshold ago
      (hs.status = 'paused'
       AND MAX(seg.ended_at) IS NOT NULL
       AND MAX(seg.ended_at) < now() - v_stale_threshold)
    )
  LOOP
    -- Calculate total accumulated duration across ALL segments
    -- For running sessions: open segment time = now() - started_at
    -- For paused sessions: all segments have ended_at, use normal sum
    SELECT COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        COALESCE(seg.ended_at, now()) - seg.started_at
      )) * 1000
    )::bigint, 0)
    INTO v_total_ms
    FROM public.habit_session_segments seg
    WHERE seg.session_id = v_session.id;

    -- Close any open segment (running sessions have one segment with ended_at IS NULL)
    IF v_session.status = 'running' THEN
      UPDATE public.habit_session_segments
      SET ended_at = now()
      WHERE session_id = v_session.id
        AND ended_at IS NULL;
    END IF;

    -- Mark session as cancelled with stale timeout reason
    UPDATE public.habit_sessions SET
      status = 'cancelled',
      estimated_ms = v_total_ms,
      completed_at = now(),
      note = COALESCE(
        CASE WHEN note IS NOT NULL AND note != ''
          THEN note || ' | '
          ELSE ''
        END || 'Auto-recovered: stale session (inactive > '
             || EXTRACT(HOURS FROM v_stale_threshold)::text || 'h)',
        'Auto-recovered: stale session'
      )
    WHERE id = v_session.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.bloom_cleanup_stale_sessions IS
  'Recovers the caller''s own stale sessions (inactive > 2 hours). '
  'SECURITY DEFINER bypasses RLS but is scoped to auth.uid() — '
  'each user can only affect their own sessions. '
  'Preserves all accumulated duration in estimated_ms. '
  'Returns count of sessions recovered.';

-- Grant to authenticated (can be called by any user, but only affects their own sessions
-- via the SECURITY DEFINER + auth.uid() check inside the function)
REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_cleanup_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_cleanup_stale_sessions() TO authenticated;

COMMIT;
