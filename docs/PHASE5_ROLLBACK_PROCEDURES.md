# Phase 5: Rollback Procedures

## Overview

This document describes how to reverse each Phase 5 migration. All DOWN scripts are in `supabase/migrations/DOWN/`.

**CRITICAL: DOWN scripts are documentation only. They must NEVER be executed automatically. Always review the data loss warnings before running any rollback.**

---

## Migration 1: User Data Snapshots

**UP:** `20261128100000_phase5_user_data_snapshots.sql`
**DOWN:** `DOWN/01_down_user_data_snapshots.sql`
**Reversibility:** ✅ Fully reversible

### What it does
- Creates `user_data_snapshots` table
- Creates `bloom_snapshot_user_data(reason)` function
- Creates `bloom_restore_user_data(snapshot_id, force)` function

### Rollback impact
- ⚠️ **DATA LOSS:** All existing snapshots are permanently deleted
- Functions are dropped (CASCADE removes dependent objects)
- No impact on actual user data (snapshots are copies, not references)

### Rollback steps
1. Confirm no active restore operations are in progress
2. Export any important snapshots before running DOWN
3. Execute `DOWN/01_down_user_data_snapshots.sql`

---

## Migration 2: Stale Session Recovery

**UP:** `20261128110000_phase5_stale_session_recovery.sql`
**DOWN:** `DOWN/02_down_stale_session_recovery.sql`
**Reversibility:** ⚠️ Partially reversible

### What it does
- Creates `bloom_cleanup_stale_sessions()` function

### Rollback impact
- Function is dropped (no new stale sessions will be auto-recovered)
- ⚠️ **DATA PERSISTS:** Sessions already cancelled by the cleanup function remain cancelled
  - They have `status = 'cancelled'` and `note` containing 'Auto-recovered: stale session'
  - Their `estimated_ms` contains the preserved duration
  - These cannot be automatically restored to 'running' state
- Manual intervention required to identify and optionally restore stale-cancelled sessions

### Rollback steps
1. Identify sessions affected by stale cleanup:
   ```sql
   SELECT id, user_id, estimated_ms, note
   FROM habit_sessions
   WHERE status = 'cancelled'
     AND note LIKE '%stale%';
   ```
2. Decide if any should be restored to their previous state
3. Execute `DOWN/02_down_stale_session_recovery.sql`

---

## Migration 3: Data Integrity Checks

**UP:** `20261128120000_phase5_data_integrity_checks.sql`
**DOWN:** `DOWN/03_down_data_integrity_checks.sql`
**Reversibility:** ✅ Fully reversible

### What it does
- Creates `bloom_check_data_integrity()` function (read-only)

### Rollback impact
- **No data loss.** The function never modifies data
- Only the ability to run integrity checks is removed

### Rollback steps
1. Execute `DOWN/03_down_data_integrity_checks.sql`

---

## Migration 4: Operation Failure Log

**UP:** `20261128130000_phase5_operation_failure_log.sql`
**DOWN:** `DOWN/04_down_operation_failure_log.sql`
**Reversibility:** ✅ Fully reversible

### What it does
- Creates `operation_failures` table
- Creates `record_operation_failure()` function
- Creates `retry_failed_operations()` function
- Creates `resolve_operation_failure()` function

### Rollback impact
- ⚠️ **DATA LOSS:** All operation failure records are permanently deleted
- Pending retries will no longer occur
- No impact on actual operations (failures are metadata, not operational data)

### Rollback steps
1. Review any pending failures:
   ```sql
   SELECT * FROM operation_failures
   WHERE status IN ('pending', 'retrying');
   ```
2. Resolve or acknowledge pending failures before rollback
3. Execute `DOWN/04_down_operation_failure_log.sql`

---

## Emergency Full Rollback

If all Phase 5 migrations must be rolled back, execute DOWN scripts in **reverse order:**

```
1. DOWN/04_down_operation_failure_log.sql
2. DOWN/03_down_data_integrity_checks.sql
3. DOWN/02_down_stale_session_recovery.sql
4. DOWN/01_down_user_data_snapshots.sql
```

### Verification after rollback
```sql
-- Confirm Phase 5 objects are gone
SELECT * FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('user_data_snapshots', 'operation_failures');
-- Should return 0 rows

SELECT * FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name LIKE 'bloom_%'
  AND routine_name IN (
    'bloom_snapshot_user_data',
    'bloom_restore_user_data',
    'bloom_cleanup_stale_sessions',
    'bloom_check_data_integrity'
  );
-- Should return 0 rows
```

---

## Non-Rollbackable Changes

Phase 5 does NOT modify any existing tables or functions from Phases 1–4. All Phase 5 changes are additive:
- New tables (`user_data_snapshots`, `operation_failures`)
- New functions (4 RPC functions)
- No schema changes to existing tables
- No changes to existing RLS policies
