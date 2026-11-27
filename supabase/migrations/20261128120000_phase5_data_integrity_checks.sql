-- Phase 5: Data Integrity Checks
-- Read-only function that detects genuine data corruption and inconsistencies.
--
-- DESIGN PRINCIPLES:
--   - Read-only: NEVER modifies user data
--   - Distinguishes genuine issues from valid states:
--     * Quick-log and legacy sessions legitimately have no segments
--     * Running sessions just created may briefly have no segments
--     * Habits with no logs are valid (newly created habits)
--   - Returns structured results with severity levels
--
-- SEVERITY LEVELS:
--   'error'   — Data corruption or constraint violation (immediate attention)
--   'warning' — Suspicious state that may indicate a problem
--   'info'    — Informational observation, not necessarily a problem

BEGIN;

-- ============================================================================
-- DATA INTEGRITY CHECK FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bloom_check_data_integrity()
RETURNS TABLE (
  issue_type text,
  severity text,
  table_name text,
  record_id text,
  description text
)
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = ''
AS $$
  WITH caller AS (
    SELECT auth.uid() AS uid
  ),

  -- ========================================================================
  -- ERROR: Orphaned habit_session_segments (session_id references nothing)
  -- This shouldn't happen with FK constraints, but check anyway.
  -- ========================================================================
  orphaned_segments AS (
    SELECT
      'orphaned_segment' AS issue_type,
      'error' AS severity,
      'habit_session_segments' AS table_name,
      seg.id::text AS record_id,
      'Segment references non-existent session ' || seg.session_id::text AS description
    FROM public.habit_session_segments seg
    INNER JOIN caller c ON seg.user_id = c.uid
    WHERE NOT EXISTS (
      SELECT 1 FROM public.habit_sessions hs
      WHERE hs.id = seg.session_id
    )
  ),

  -- ========================================================================
  -- ERROR: Orphaned habit_session_goal_versions (habit_id references nothing)
  -- ========================================================================
  orphaned_goal_versions AS (
    SELECT
      'orphaned_goal_version' AS issue_type,
      'error' AS severity,
      'habit_session_goal_versions' AS table_name,
      gv.id::text AS record_id,
      'Goal version references non-existent habit ' || gv.habit_id::text AS description
    FROM public.habit_session_goal_versions gv
    INNER JOIN caller c ON gv.user_id = c.uid
    WHERE NOT EXISTS (
      SELECT 1 FROM public.habits h
      WHERE h.id = gv.habit_id
    )
  ),

  -- ========================================================================
  -- WARNING: Timed session with no segments (should always have at least one)
  -- Excludes quick/legacy sources — they legitimately have no segments.
  -- Also excludes very recently created sessions (< 1 minute old).
  -- ========================================================================
  timed_sessions_no_segments AS (
    SELECT
      'timed_session_no_segments' AS issue_type,
      'warning' AS severity,
      'habit_sessions' AS table_name,
      hs.id::text AS record_id,
      'Timed session (status=' || hs.status || ') has no segments' AS description
    FROM public.habit_sessions hs
    INNER JOIN caller c ON hs.user_id = c.uid
    WHERE hs.source = 'timed'
      AND hs.status IN ('running', 'paused')
      AND hs.created_at < now() - interval '1 minute'
      AND NOT EXISTS (
        SELECT 1 FROM public.habit_session_segments seg
        WHERE seg.session_id = hs.id
      )
  ),

  -- ========================================================================
  -- WARNING: Segment with ended_at in the future
  -- ========================================================================
  future_segments AS (
    SELECT
      'future_segment' AS issue_type,
      'warning' AS severity,
      'habit_session_segments' AS table_name,
      seg.id::text AS record_id,
      'Segment ended_at is in the future: ' || seg.ended_at::text AS description
    FROM public.habit_session_segments seg
    INNER JOIN caller c ON seg.user_id = c.uid
    WHERE seg.ended_at IS NOT NULL
      AND seg.ended_at > now() + interval '1 minute'
  ),

  -- ========================================================================
  -- WARNING: Segment with ended_at before started_at (negative duration)
  -- ========================================================================
  negative_segments AS (
    SELECT
      'negative_duration_segment' AS issue_type,
      'warning' AS severity,
      'habit_session_segments' AS table_name,
      seg.id::text AS record_id,
      'Segment ended_at (' || seg.ended_at::text || ') before started_at (' || seg.started_at::text || ')' AS description
    FROM public.habit_session_segments seg
    INNER JOIN caller c ON seg.user_id = c.uid
    WHERE seg.ended_at IS NOT NULL
      AND seg.ended_at < seg.started_at
  ),

  -- ========================================================================
  -- WARNING: Session with negative total duration
  -- ========================================================================
  negative_sessions AS (
    SELECT
      'negative_session_duration' AS issue_type,
      'warning' AS severity,
      'habit_sessions' AS table_name,
      hs.id::text AS record_id,
      'Session has negative ' ||
        CASE WHEN hs.duration_ms IS NOT NULL THEN 'duration_ms=' || hs.duration_ms
             ELSE 'estimated_ms=' || hs.estimated_ms
        END AS description
    FROM public.habit_sessions hs
    INNER JOIN caller c ON hs.user_id = c.uid
    WHERE (hs.duration_ms IS NOT NULL AND hs.duration_ms < 0)
       OR (hs.estimated_ms IS NOT NULL AND hs.estimated_ms < 0)
  ),

  -- ========================================================================
  -- WARNING: Completed session with no duration or estimated time
  -- ========================================================================
  completed_no_duration AS (
    SELECT
      'completed_no_duration' AS issue_type,
      'warning' AS severity,
      'habit_sessions' AS table_name,
      hs.id::text AS record_id,
      'Completed session has no duration_ms and no estimated_ms' AS description
    FROM public.habit_sessions hs
    INNER JOIN caller c ON hs.user_id = c.uid
    WHERE hs.status = 'completed'
      AND hs.duration_ms IS NULL
      AND hs.estimated_ms IS NULL
  ),

  -- ========================================================================
  -- WARNING: Multiple open segments for the same session
  -- Only one segment should have ended_at IS NULL at any time.
  -- ========================================================================
  multiple_open_segments AS (
    SELECT
      'multiple_open_segments' AS issue_type,
      'error' AS severity,
      'habit_session_segments' AS table_name,
      seg.session_id::text AS record_id,
      'Session has ' || COUNT(*)::text || ' open segments (should be at most 1)' AS description
    FROM public.habit_session_segments seg
    INNER JOIN caller c ON seg.user_id = c.uid
    WHERE seg.ended_at IS NULL
    GROUP BY seg.session_id
    HAVING COUNT(*) > 1
  ),

  -- ========================================================================
  -- WARNING: Habit log dated in the future (more than 1 day ahead of Lagos date)
  -- ========================================================================
  future_logs AS (
    SELECT
      'future_dated_log' AS issue_type,
      'warning' AS severity,
      'habit_logs' AS table_name,
      hl.id::text AS record_id,
      'Habit log dated ' || hl.completed_on::text || ' (future date in Africa/Lagos)' AS description
    FROM public.habit_logs hl
    INNER JOIN caller c ON hl.user_id = c.uid
    WHERE hl.completed_on > public.lagos_date() + interval '1 day'
  ),

  -- ========================================================================
  -- INFO: Stale sessions (running/paused > 2 hours) — informational only
  -- These are candidates for bloom_cleanup_stale_sessions()
  -- ========================================================================
  stale_sessions AS (
    SELECT
      'stale_active_session' AS issue_type,
      'info' AS severity,
      'habit_sessions' AS table_name,
      hs.id::text AS record_id,
      'Session ' || hs.status || ' for > ' ||
        ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(
          (SELECT MAX(seg.ended_at) FROM public.habit_session_segments seg
           WHERE seg.session_id = hs.id AND seg.ended_at IS NOT NULL),
          (SELECT MAX(seg.started_at) FROM public.habit_session_segments seg
           WHERE seg.session_id = hs.id)
        ))) / 3600)::text || ' hours' AS description
    FROM public.habit_sessions hs
    INNER JOIN caller c ON hs.user_id = c.uid
    WHERE hs.status IN ('running', 'paused')
      AND (
        (hs.status = 'running' AND EXISTS (
          SELECT 1 FROM public.habit_session_segments seg
          WHERE seg.session_id = hs.id AND seg.ended_at IS NULL
          AND seg.started_at < now() - interval '2 hours'
        ))
        OR
        (hs.status = 'paused' AND EXISTS (
          SELECT 1 FROM public.habit_session_segments seg
          WHERE seg.session_id = hs.id
          GROUP BY seg.session_id
          HAVING MAX(seg.ended_at) < now() - interval '2 hours'
        ))
      )
  )

  -- Combine all checks
  SELECT issue_type, severity, table_name, record_id, description FROM orphaned_segments
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM orphaned_goal_versions
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM timed_sessions_no_segments
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM future_segments
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM negative_segments
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM negative_sessions
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM completed_no_duration
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM multiple_open_segments
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM future_logs
  UNION ALL
  SELECT issue_type, severity, table_name, record_id, description FROM stale_sessions;
$$;

COMMENT ON FUNCTION public.bloom_check_data_integrity IS
  'Read-only integrity check: detects orphaned records, negative durations, '
  'multiple open segments, future-dated logs, and stale sessions. '
  'Excludes valid states (quick/legacy sessions without segments, new habits without logs). '
  'NEVER modifies data.';

REVOKE ALL PRIVILEGES ON FUNCTION public.bloom_check_data_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bloom_check_data_integrity() TO authenticated;

COMMIT;
