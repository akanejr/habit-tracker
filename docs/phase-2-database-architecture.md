# Phase 2: Database Architecture

**Branch:** `bloom/phase-2-database-architecture`  
**Base Commit:** `f54f20db65c6505d42f4bead1bea16fe0daf2774`  
**Status:** In Progress  
**Last Updated:** 2026-11-25

---

## Executive Summary

Phase 2 establishes a robust relational database architecture for Bloom, transitioning from the Phase 1 day-based habit tracking model to a comprehensive session-based system. This architecture supports multiple sessions per habit per day, accurate duration tracking (measured, estimated, and unknown), weekly goal versioning with Africa/Lagos timezone awareness, and maintains complete historical integrity.

---

## Current State Analysis

### Existing Tables (Phase 1)

1. **`profiles`** - User profile information
2. **`habits`** - Habit definitions with day-based targets (1-7 per week)
3. **`habit_logs`** - Day-based completion records (one per habit per day)
4. **`habit_versions`** - Habit configuration history (read-only snapshots)

### Missing Infrastructure

The TypeScript types define session-related structures that do not yet exist in the database:

- `habit_sessions` - Canonical session records
- `habit_session_segments` - Timer interval tracking
- `habit_session_goal_versions` - Weekly goal versioning
- RPC functions for session lifecycle management

---

## Design Objectives

### Primary Requirements

1. **Multiple Sessions Per Day** - A habit can have multiple completed sessions on the same date
2. **Session Duration Tracking** - Distinguish between:
   - **Measured duration** - Actual elapsed time from timer (milliseconds)
   - **Estimated duration** - User-provided estimate for quick logs (milliseconds)
   - **Unknown duration** - Session completed without duration data
3. **Weekly Goal Versioning** - Goals can change over time with historical preservation:
   - Targets can exceed 7 sessions per week
   - Users can explicitly choose "no target" (null)
   - Changes take effect at the next Monday in Africa/Lagos timezone
   - Historical performance remains interpretable against the goal that applied at that time
4. **Timezone Awareness** - All date calculations use Africa/Lagos timezone
5. **Data Integrity** - Foreign keys, constraints, and cascading deletes prevent orphaned records
6. **Archived Habit Support** - Archived habits retain their historical sessions and goals
7. **Midnight Crossing** - Sessions that span midnight are attributed to the correct date

### Non-Goals (Deferred to Later Phases)

- Timer reliability and crash recovery (Phase 4)
- Production security hardening (Phase 3)
- Performance optimization beyond basic indexing
- Real-time synchronization

---

## Entity Relationship Model

```
┌─────────────┐
│   users     │ (auth.users - Supabase managed)
│  (id: uuid) │
└──────┬──────┘
       │ 1:N
       │
       ├──────────────────────────────────────┐
       │                                      │
       ▼                                      ▼
┌─────────────┐                      ┌─────────────────┐
│  profiles   │                      │     habits      │
│  (id: uuid) │                      │  (id: uuid)     │
│  user_id FK │                      │  user_id FK     │
└─────────────┘                      └────────┬────────┘
                                              │ 1:N
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
                    ▼                         ▼                         ▼
           ┌────────────────┐      ┌──────────────────┐      ┌─────────────────────┐
           │ habit_versions │      │  habit_sessions  │      │habit_session_goals  │
           │ (id: bigint)   │      │   (id: uuid)     │      │   (id: bigint)      │
           │ habit_id FK    │      │   habit_id FK    │      │   habit_id FK       │
           │ user_id FK     │      │   user_id FK     │      │   user_id FK        │
           └────────────────┘      └─────────┬────────┘      └─────────────────────┘
                                             │ 1:N
                                             │
                                             ▼
                                  ┌──────────────────────┐
                                  │habit_session_segments│
                                  │    (id: bigint)      │
                                  │   session_id FK      │
                                  │    user_id FK        │
                                  └──────────────────────┘
```

---

## Table Specifications

### 1. `habit_sessions`

**Purpose:** Canonical record of all habit sessions, replacing the day-based `habit_logs` model.

**Columns:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `uuid` | PRIMARY KEY, DEFAULT gen_random_uuid() | Unique session identifier |
| `user_id` | `uuid` | NOT NULL, FK → auth.users(id) ON DELETE CASCADE | Session owner |
| `habit_id` | `uuid` | NOT NULL, FK → habits(id) ON DELETE CASCADE | Associated habit |
| `source` | `text` | NOT NULL, CHECK IN ('timed', 'quick', 'legacy') | How the session was created |
| `status` | `text` | NOT NULL, CHECK IN ('running', 'paused', 'completed', 'cancelled') | Current session state |
| `recording_mode` | `text` | NOT NULL, CHECK IN ('timer', 'quick', 'legacy') | Duration measurement method |
| `completed_on` | `date` | NULL (until completed), CHECK valid date format | Africa/Lagos date when completed |
| `duration_ms` | `bigint` | NULL, CHECK >= 0 | Measured duration in milliseconds (timed sessions only) |
| `estimated_ms` | `bigint` | NULL, CHECK >= 0 | Estimated duration in milliseconds (quick logs only) |
| `note` | `text` | NULL | Optional user note |
| `started_at` | `timestamptz` | NULL | When the session started (timed sessions only) |
| `completed_at` | `timestamptz` | NULL | When the session completed |
| `start_version_id` | `bigint` | NULL, FK → habit_versions(id) | Habit version at session start |
| `completion_version_id` | `bigint` | NULL, FK → habit_versions(id) | Habit version at completion |
| `legacy_log_id` | `uuid` | NULL, FK → habit_logs(id) | Reference to migrated Phase 1 log |
| `created_at` | `timestamptz` | NOT NULL, DEFAULT now() | Record creation timestamp |

**Constraints:**

- `CHECK (duration_ms IS NULL OR estimated_ms IS NULL)` - Cannot have both measured and estimated duration
- `CHECK (source = 'timed' OR status != 'running')` - Only timed sessions can be running
- `CHECK (status = 'completed' OR completed_on IS NULL)` - Only completed sessions have completion date
- `CHECK (status = 'completed' OR duration_ms IS NULL)` - Only completed sessions have final duration
- `CHECK (source = 'timed' OR started_at IS NULL)` - Only timed sessions have start time
- `CHECK (source != 'timed' OR start_version_id IS NOT NULL)` - Timed sessions must reference habit version
- `UNIQUE (user_id, habit_id, completed_on, source)` - Prevents duplicate sessions (allows multiple per day if different sources)

**Indexes:**

- `habit_sessions_user_id_idx` - (user_id) - User session queries
- `habit_sessions_habit_id_idx` - (habit_id) - Habit session queries
- `habit_sessions_completed_on_idx` - (completed_on) - Date range queries
- `habit_sessions_status_idx` - (status) WHERE status IN ('running', 'paused') - Active session lookup

**Row-Level Security:**

- `habit_sessions_select_own` - Users can only view their own sessions
- `habit_sessions_insert_own` - Users can only create sessions for their own habits
- `habit_sessions_update_own` - Users can only update their own sessions
- `habit_sessions_delete_own` - Users can only delete their own sessions

---

### 2. `habit_session_segments`

**Purpose:** Track individual timer intervals for timed sessions, supporting pause/resume functionality.

**Columns:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigint` | PRIMARY KEY, GENERATED ALWAYS AS IDENTITY | Unique segment identifier |
| `session_id` | `uuid` | NOT NULL, FK → habit_sessions(id) ON DELETE CASCADE | Parent session |
| `user_id` | `uuid` | NOT NULL, FK → auth.users(id) ON DELETE CASCADE | Segment owner (denormalized for RLS) |
| `started_at` | `timestamptz` | NOT NULL | When this segment started |
| `ended_at` | `timestamptz` | NULL | When this segment ended (NULL if currently running) |

**Constraints:**

- `CHECK (ended_at IS NULL OR ended_at >= started_at)` - Segment cannot end before it starts

**Indexes:**

- `habit_session_segments_session_id_idx` - (session_id) - Session segment queries
- `habit_session_segments_user_id_idx` - (user_id) - User segment queries
- `habit_session_segments_active_idx` - (session_id) WHERE ended_at IS NULL - Active segment lookup

**Row-Level Security:**

- `habit_session_segments_select_own` - Users can only view their own segments
- `habit_session_segments_insert_own` - Users can only create segments for their own sessions
- `habit_session_segments_update_own` - Users can only update their own segments
- No delete policy (segments are managed via session deletion cascade)

---

### 3. `habit_session_goal_versions`

**Purpose:** Track weekly session goal changes with historical preservation and effective dates.

**Columns:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | `bigint` | PRIMARY KEY, GENERATED ALWAYS AS IDENTITY | Unique version identifier |
| `habit_id` | `uuid` | NOT NULL, FK → habits(id) ON DELETE CASCADE | Associated habit |
| `user_id` | `uuid` | NOT NULL, FK → auth.users(id) ON DELETE CASCADE | Goal owner |
| `effective_week` | `date` | NOT NULL, CHECK is Monday in Africa/Lagos | Week start date (Monday) when this goal takes effect |
| `goal_confirmed` | `boolean` | NOT NULL, DEFAULT false | Whether the user has explicitly confirmed this goal |
| `weekly_session_target` | `integer` | NULL, CHECK >= 1 | Target sessions per week (NULL = no target) |
| `recorded_at` | `timestamptz` | NOT NULL, DEFAULT now() | When this version was recorded |

**Constraints:**

- `UNIQUE (habit_id, effective_week)` - Only one goal version per habit per week
- `CHECK (weekly_session_target IS NULL OR weekly_session_target >= 1)` - Target must be positive if specified

**Indexes:**

- `habit_session_goal_versions_habit_id_idx` - (habit_id, effective_week DESC) - Goal history queries
- `habit_session_goal_versions_user_id_idx` - (user_id) - User goal queries
- `habit_session_goal_versions_effective_idx` - (effective_week) - Week-based queries

**Row-Level Security:**

- `habit_session_goal_versions_select_own` - Users can only view their own goal versions
- `habit_session_goal_versions_insert_own` - Users can only create goal versions for their own habits
- No update or delete policies (goal versions are immutable once created)

---

### 4. `habits` Table Modifications

**New Columns:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `session_goal_type` | `text` | NULL, CHECK IN ('none', 'weekly') | Type of session goal (NULL = not configured) |

**Note:** The existing `target_per_week` column remains for backward compatibility with Phase 1 day-based goals. Session-based goals are tracked in `habit_session_goal_versions`.

---

## RPC Function Specifications

### Session Lifecycle Functions

1. **`bloom_start_session(p_user_id uuid, p_habit_id uuid)`**
   - Creates a new timed session with status 'running'
   - Creates initial segment with started_at = now()
   - Returns the new session record
   - Validates: habit exists, belongs to user, is active, no other running session

2. **`bloom_pause_session(p_user_id uuid, p_session_id uuid)`**
   - Updates session status to 'paused'
   - Closes the current segment (sets ended_at = now())
   - Returns updated session record
   - Validates: session exists, belongs to user, status is 'running'

3. **`bloom_resume_session(p_user_id uuid, p_session_id uuid)`**
   - Updates session status to 'running'
   - Creates new segment with started_at = now()
   - Returns updated session record
   - Validates: session exists, belongs to user, status is 'paused'

4. **`bloom_complete_session(p_user_id uuid, p_session_id uuid)`**
   - Calculates total duration from all segments
   - Updates session: status = 'completed', duration_ms = calculated, completed_at = now(), completed_on = lagos_date(now())
   - Closes any open segment
   - Returns updated session record
   - Validates: session exists, belongs to user, status is 'running' or 'paused'

5. **`bloom_cancel_session(p_user_id uuid, p_session_id uuid)`**
   - Updates session status to 'cancelled'
   - Closes any open segment
   - Returns updated session record
   - Validates: session exists, belongs to user, status is 'running' or 'paused'

6. **`bloom_quick_log(p_user_id uuid, p_habit_id uuid, p_completed_on date, p_estimated_ms bigint, p_note text)`**
   - Creates a completed quick log session with estimated duration
   - Returns the new session record
   - Validates: habit exists, belongs to user, is active, date is valid (not future)

### Goal Management Functions

7. **`bloom_set_weekly_goal(p_user_id uuid, p_habit_id uuid, p_effective_week date, p_weekly_session_target integer)`**
   - Creates a new goal version effective at the specified week
   - Validates: habit exists, belongs to user, effective_week is a Monday, target is positive or null
   - Returns the new goal version record

---

## Africa/Lagos Timezone Handling

All date calculations must use the Africa/Lagos timezone (WAT, UTC+1, no DST).

**Implementation Strategy:**

1. **Database Functions:** Create helper functions for timezone-aware date operations:
   ```sql
   CREATE FUNCTION lagos_date(ts timestamptz) RETURNS date AS $$
     SELECT (ts AT TIME ZONE 'Africa/Lagos')::date;
   $$ LANGUAGE sql IMMUTABLE;
   
   CREATE FUNCTION lagos_week_start(d date) RETURNS date AS $$
     SELECT d - ((EXTRACT(DOW FROM d)::integer + 6) % 7);
   $$ LANGUAGE sql IMMUTABLE;
   ```

2. **Application Layer:** Use the `lib/habits/dates.ts` module for all date calculations:
   - `lagosDate(date: Date): string` - Convert timestamp to Africa/Lagos date (YYYY-MM-DD)
   - `weekStart(date: string): string` - Get Monday of the week containing the date
   - `nextWeek(monday: string): string` - Get the next Monday

3. **Session Completion:** When a session completes, calculate `completed_on` using Africa/Lagos timezone at the moment of completion.

4. **Goal Effective Dates:** Goals always take effect on Monday in Africa/Lagos timezone. When a user sets a goal, calculate the next Monday and use that as `effective_week`.

---

## Migration Strategy

### Migration 1: Create Session Tables

**File:** `supabase/migrations/YYYYMMDDHHMMSS_phase2_session_tables.sql`

**Operations:**
1. Create `habit_sessions` table with all columns and constraints
2. Create `habit_session_segments` table with all columns and constraints
3. Create indexes for performance
4. Enable RLS and create policies
5. Grant appropriate privileges

### Migration 2: Create Goal Versioning Table

**File:** `supabase/migrations/YYYYMMDDHHMMSS_phase2_goal_versions.sql`

**Operations:**
1. Create `habit_session_goal_versions` table
2. Create indexes
3. Enable RLS and create policies
4. Migrate existing `habits.target_per_week` to initial goal versions (if applicable)

### Migration 3: Create RPC Functions

**File:** `supabase/migrations/YYYYMMDDHHMMSS_phase2_session_functions.sql`

**Operations:**
1. Create timezone helper functions
2. Create session lifecycle functions
3. Create goal management functions
4. Set appropriate privileges

### Migration 4: Add Session Goal Type to Habits

**File:** `supabase/migrations/YYYYMMDDHHMMSS_phase2_habit_goal_type.sql`

**Operations:**
1. Add `session_goal_type` column to `habits` table
2. Update TypeScript types

---

## Data Integrity Rules

### 1. Session State Transitions

```
[New] → running → paused → running → ... → completed
                    ↓
                cancelled
```

- Only 'running' sessions can transition to 'paused'
- Only 'paused' sessions can transition to 'running'
- 'running' or 'paused' sessions can transition to 'completed' or 'cancelled'
- 'completed' and 'cancelled' are terminal states

### 2. Duration Rules

- **Timed sessions:** `duration_ms` is calculated from segments, `estimated_ms` is NULL
- **Quick logs:** `estimated_ms` is user-provided, `duration_ms` is NULL
- **Legacy logs:** Both `duration_ms` and `estimated_ms` are NULL (unknown duration)
- Constraint prevents both from being non-NULL simultaneously

### 3. Completion Date Rules

- Only 'completed' sessions have a `completed_on` date
- The date is calculated in Africa/Lagos timezone at completion time
- Quick logs can specify a past date (but not future)
- Timed sessions use the completion timestamp's date

### 4. Goal Version Rules

- Goal versions are immutable once created
- Each version has an `effective_week` (Monday in Africa/Lagos)
- The active goal for a given week is the most recent version where `effective_week <= week_start`
- Unconfirmed goals (`goal_confirmed = false`) are treated as "no goal"

### 5. Archived Habit Rules

- Archived habits (`is_active = false`) cannot have new sessions created
- Existing sessions remain accessible for historical reporting
- Goal versions remain accessible for historical reporting

---

## Security Considerations

### Row-Level Security (RLS)

All tables have RLS enabled with policies ensuring users can only access their own data:

- **Select:** Users can only view records where `user_id = auth.uid()`
- **Insert:** Users can only create records where `user_id = auth.uid()` and the habit belongs to them
- **Update:** Users can only update records where `user_id = auth.uid()`
- **Delete:** Users can only delete records where `user_id = auth.uid()`

### Privilege Separation

- **Anonymous users:** No access to any tables
- **Authenticated users:** Full CRUD on their own data via RLS
- **Service role:** Bypasses RLS for administrative operations (not exposed to client)

### Future Security Enhancements (Phase 3)

- Audit logging for sensitive operations
- Rate limiting on session creation
- Validation of habit ownership in RPC functions
- Protection against concurrent session manipulation

---

## Testing Strategy

### Unit Tests

1. **Timezone Functions:**
   - `lagos_date()` correctly converts timestamps across DST boundaries
   - `lagos_week_start()` returns Monday for any date
   - Edge cases: midnight crossings, timezone changes

2. **Session Lifecycle:**
   - Start/pause/resume/complete/cancel transitions
   - Duration calculation from segments
   - Completion date calculation
   - Invalid state transitions are rejected

3. **Goal Versioning:**
   - Goal creation with various targets
   - Effective week calculation
   - Historical goal retrieval
   - Unconfirmed vs confirmed goals

### Integration Tests

1. **Data Integrity:**
   - Foreign key constraints prevent orphaned records
   - Cascading deletes work correctly
   - Unique constraints prevent duplicates
   - Check constraints enforce business rules

2. **Performance:**
   - Indexes are used for common queries
   - Large datasets (10,000+ sessions) perform acceptably
   - Concurrent operations don't cause deadlocks

3. **Migration Safety:**
   - Migrations can be applied to empty database
   - Migrations can be applied to Phase 1 database
   - Rollback procedures work correctly

### Regression Tests

- All Phase 1 functionality continues to work
- Existing habits and logs are preserved
- Habit version history is maintained
- RLS policies remain effective

---

## Known Limitations

### 1. Timer Reliability (Deferred to Phase 4)

The current architecture does not guarantee timer state persistence across crashes or network failures. If the application crashes while a session is 'running', the segment may remain open indefinitely. Phase 4 will implement:

- Heartbeat mechanism to detect stale sessions
- Automatic segment closure after timeout
- Client-side timer state reconciliation

### 2. Concurrent Session Manipulation

The architecture does not prevent race conditions when multiple clients manipulate the same session simultaneously. For example:

- Client A pauses a session
- Client B completes the same session before receiving the pause update
- Result: Session state may be inconsistent

Phase 4 will implement optimistic locking or server-side state machines.

### 3. Goal Scheduling Complexity

Calculating the next Monday in Africa/Lagos timezone requires careful handling of:

- Timezone offsets (WAT is UTC+1, no DST)
- Week boundary crossings
- User's local timezone vs Africa/Lagos

The current implementation uses application-layer calculations. A more robust solution might use PostgreSQL's timezone-aware date functions.

### 4. Legacy Data Migration

The architecture supports `legacy_log_id` references to Phase 1 `habit_logs`, but does not automatically migrate existing logs to sessions. A separate migration script will be needed to:

- Convert each `habit_log` to a `habit_session` with `source = 'legacy'`
- Preserve the original completion date
- Set `duration_ms` and `estimated_ms` to NULL (unknown)

---

## Future Considerations

### Phase 3: Security Hardening

- Implement audit logging for all session operations
- Add rate limiting to prevent abuse
- Validate habit ownership in all RPC functions
- Implement secure session tokens for timer operations

### Phase 4: Timer Reliability

- Implement heartbeat mechanism for active sessions
- Add automatic segment closure after timeout
- Implement client-server state reconciliation
- Add crash recovery procedures

### Phase 5: Advanced Features

- Support for recurring sessions (e.g., "every Monday at 9 AM")
- Session templates for common activities
- Session tags and categorization
- Advanced reporting and analytics

---

## Conclusion

This database architecture provides a solid foundation for Bloom's session-based tracking system. It maintains data integrity through comprehensive constraints, supports complex business rules via RPC functions, and ensures security through row-level security policies. The design is extensible, allowing for future enhancements without requiring schema changes.

The architecture successfully addresses all Phase 2 requirements while clearly documenting limitations that will be addressed in subsequent phases.
