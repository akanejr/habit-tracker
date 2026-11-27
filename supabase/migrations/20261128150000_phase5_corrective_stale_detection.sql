-- Phase 5 Corrective Migration 2: Stale Session Detection Fix
--
-- The previous implementation used MAX(seg.ended_at) IS NULL to identify
-- running sessions with open segments. This is incorrect because PostgreSQL's
-- MAX() aggregate ignores NULL values. A session with both closed segments
-- (ended_at NOT NULL) and one open segment (ended_at IS NULL) would return
-- MAX(ended_at) as the latest closed value, not NULL.
--
-- FIX: Use EXISTS() to check for an open segment, and compute last_activity
-- as the most recent of MAX(ended_at) or MAX(started_at) across all segments.
--
-- Also adds concurrent-safety: the function uses FOR UPDATE on the session
-- rows it intends to modify, preventing two concurrent cleanup calls from
-- double-cancelling the same session.

BEGIN;

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

  -- Find stale sessions using correct detection logic:
  --   Running: has an open segment (ended_at IS NULL) AND that segment started > threshold ago
  --   Paused:  last closed segment ended > threshold ago
  -- Uses EXISTS() instead of MAX(ended_at) IS NULL for correctness.
  FOR v_session IN
    SELECT
      hs.id,
      hs.status,
      -- Last activity: the most recent meaningful timestamp
      -- For running: the open segment's started_at (it's still running)
      -- For paused: the last closed segment's ended_at
      COALESCE(
        (SELECT MAX(seg.ended_at) FROM public.habit_session_segments seg
         WHERE seg.session_id = hs.id AND seg.ended_at IS NOT NULL),
        (SELECT MAX(seg.started_at) FROM public.habit_session_segments seg
         WHERE seg.session_id = hs.id)
      ) AS last_activity,
      -- Whether this session has an open segment
      EXISTS(
        SELECT 1 FROM public.habit_session_segments seg
        WHERE seg.session_id = hs.id AND seg.ended_at IS NULL
      ) AS has_open_segment
    FROM public.habit_sessions hs
    WHERE hs.status IN ('running', 'paused')
      AND hs.user_id = v_user_id
      AND EXISTS (SELECT 1 FROM public.habit_session_segments seg WHERE seg.session_id = hs.id)
    FOR UPDATE OF hs  -- Prevent concurrent cleanup from double-processing
  LOOP
    -- Check staleness based on status
    IF v_session.status = 'running' THEN
      -- Running session is stale if it has an open segment that started > threshold ago
      IF NOT v_session.has_open_segment THEN
        CONTINUE;  -- Running without open segment is unusual but not stale by this rule
      END IF;
      -- Check the open segment's started_at
      IF NOT EXISTS (
        SELECT 1 FROM public.habit_session_segments seg
        WHERE seg.session_id = v_session.id
          AND seg.ended_at IS NULL
          AND seg.started_at < now() - v_stale_threshold
      ) THEN
        CONTINUE;  -- Open segment is still within threshold
      END IF;
    ELSIF v_session.status = 'paused' THEN
      -- Paused session is stale if last closed segment ended > threshold ago
      IF v_session.last_activity IS NULL
         OR v_session.last_activity >= now() - v_stale_threshold THEN
        CONTINUE;
      END IF;
    END IF;

    -- Calculate total accumulated duration across ALL segments
    SELECT COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        COALESCE(seg.ended_at, now()) - seg.started_at
      )) * 1000
    )::bigint, 0)
    INTO v_total_ms
    FROM public.habit_session_segments seg
    WHERE seg.session_id = v_session.id;

    -- Close any open segment (idempotent: only affects rows with ended_at IS NULL)
    IF v_session.has_open_segment THEN
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
    WHERE id = v_session.id
      AND status IN ('running', 'paused');  -- Guard against concurrent modification

    IF FOUND THEN
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.bloom_cleanup_stale_sessions IS
  'Recovers the caller''s own stale sessions (inactive > 2 hours). '
  'Uses EXISTS() for open-segment detection (correct with mixed segments). '
  'FOR UPDATE prevents concurrent double-recovery. '
  'Preserves all accumulated duration in estimated_ms.';

REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_cleanup_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_cleanup_stale_sessions() TO authenticated;

COMMIT;
