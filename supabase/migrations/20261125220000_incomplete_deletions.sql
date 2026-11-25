-- Migration: Incomplete deletions tracking for recovery
BEGIN;

CREATE TABLE IF NOT EXISTS public.incomplete_deletions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  user_email text NOT NULL,
  database_deleted_at timestamptz NOT NULL DEFAULT now(),
  auth_deletion_attempts integer NOT NULL DEFAULT 1,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for finding unresolved deletions
CREATE INDEX IF NOT EXISTS idx_incomplete_deletions_unresolved 
  ON public.incomplete_deletions (resolved, user_id) 
  WHERE resolved = false;

-- Index for finding by email (for recovery)
CREATE INDEX IF NOT EXISTS idx_incomplete_deletions_email 
  ON public.incomplete_deletions (user_email) 
  WHERE resolved = false;

-- Enable RLS
ALTER TABLE public.incomplete_deletions ENABLE ROW LEVEL SECURITY;

-- Only service role can access this table (no user-facing policies)
-- This is intentionally restrictive - only the recovery function should access it

-- Function to retry incomplete deletions (service role only)
CREATE OR REPLACE FUNCTION public.retry_incomplete_deletions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_record record;
  v_success_count integer := 0;
  v_failure_count integer := 0;
  v_results jsonb := '[]'::jsonb;
BEGIN
  -- This function should only be called by service role
  -- It will be called from the API route with service role credentials
  
  FOR v_record IN 
    SELECT id, user_id, user_email, auth_deletion_attempts 
    FROM public.incomplete_deletions 
    WHERE resolved = false 
    ORDER BY created_at ASC
    LIMIT 10  -- Process in batches
  LOOP
    -- The actual Auth deletion will be done by the API route
    -- This function just marks records for processing
    v_results := v_results || jsonb_build_object(
      'id', v_record.id,
      'user_id', v_record.user_id,
      'user_email', v_record.user_email,
      'attempts', v_record.auth_deletion_attempts
    );
  END LOOP;
  
  RETURN jsonb_build_object(
    'pending_deletions', v_results,
    'count', jsonb_array_length(v_results)
  );
END;
$$;

-- Function to mark deletion as resolved
CREATE OR REPLACE FUNCTION public.mark_deletion_resolved(p_deletion_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.incomplete_deletions
  SET resolved = true, resolved_at = now()
  WHERE id = p_deletion_id;
END;
$$;

-- Function to record incomplete deletion
CREATE OR REPLACE FUNCTION public.record_incomplete_deletion(
  p_user_id uuid,
  p_user_email text,
  p_error text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.incomplete_deletions (user_id, user_email, last_error)
  VALUES (p_user_id, p_user_email, p_error)
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$;

-- Function to increment attempt counter
CREATE OR REPLACE FUNCTION public.increment_deletion_attempt(p_deletion_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.incomplete_deletions
  SET auth_deletion_attempts = auth_deletion_attempts + 1,
      last_attempt_at = now()
  WHERE id = p_deletion_id;
END;
$$;

-- Grant execute to authenticated (for recording) and service role (for recovery)
GRANT EXECUTE ON FUNCTION public.record_incomplete_deletion TO authenticated;
GRANT EXECUTE ON FUNCTION public.retry_incomplete_deletions TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_deletion_resolved TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_deletion_attempt TO service_role;

COMMIT;
