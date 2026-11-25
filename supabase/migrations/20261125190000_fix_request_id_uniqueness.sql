-- Migration: Fix request ID uniqueness constraint
-- Date: 2026-11-25
-- Purpose: Ensure request_id is unique per user across ALL operations, not just per operation type

BEGIN;

-- Drop the old constraint that allowed same request_id for different operations
ALTER TABLE public.session_command_requests
DROP CONSTRAINT IF EXISTS unique_request_per_user_operation;

-- Add new constraint: request_id must be unique per user (regardless of operation type)
-- This prevents a user from reusing the same request_id for different operations
ALTER TABLE public.session_command_requests
ADD CONSTRAINT unique_request_per_user UNIQUE (request_id, user_id);

-- Add comment explaining the constraint
COMMENT ON CONSTRAINT unique_request_per_user ON public.session_command_requests IS
  'Ensures each request_id is unique per user across all operation types. '
  'Prevents request ID reuse for different operations, providing true idempotency.';

COMMIT;
