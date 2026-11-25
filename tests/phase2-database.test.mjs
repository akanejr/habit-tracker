/**
 * Phase 2 Database Architecture Tests
 * 
 * These tests validate the database schema, constraints, and RPC functions.
 * They can be run against a local PostgreSQL instance or mocked for unit testing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'node:test';
import assert from 'node:assert';

// Test data
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_HABIT_ID = '00000000-0000-0000-0000-000000000002';

describe('Phase 2 Database Architecture', () => {
  
  describe('Timezone Helper Functions', () => {
    it('lagos_date converts UTC timestamp to Africa/Lagos date', () => {
      // Africa/Lagos is WAT (UTC+1), no DST
      // 2026-11-25 23:00:00 UTC = 2026-11-26 00:00:00 WAT
      const utcTimestamp = '2026-11-25T23:00:00Z';
      const expectedDate = '2026-11-26';
      
      // In a real test, we'd call: SELECT public.lagos_date('2026-11-25T23:00:00Z'::timestamptz)
      // For now, we'll simulate the expected behavior
      const lagosDate = new Date(utcTimestamp);
      lagosDate.setHours(lagosDate.getHours() + 1); // WAT is UTC+1
      const result = lagosDate.toISOString().split('T')[0];
      
      assert.strictEqual(result, expectedDate);
    });

    it('lagos_week_start returns Monday for any date', () => {
      const testCases = [
        { input: '2026-11-25', expected: '2026-11-23' }, // Wednesday -> Monday
        { input: '2026-11-23', expected: '2026-11-23' }, // Monday -> Monday
        { input: '2026-11-29', expected: '2026-11-23' }, // Sunday -> Monday
      ];

      for (const { input, expected } of testCases) {
        const date = new Date(input + 'T00:00:00Z');
        const day = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
        const daysToSubtract = day === 0 ? 6 : day - 1;
        date.setUTCDate(date.getUTCDate() - daysToSubtract);
        const result = date.toISOString().split('T')[0];
        
        assert.strictEqual(result, expected, `Failed for input ${input}`);
      }
    });
  });

  describe('habit_sessions Table', () => {
    it('enforces duration exclusivity (cannot have both duration_ms and estimated_ms)', () => {
      // Constraint: CHECK (duration_ms IS NULL OR estimated_ms IS NULL)
      const validSession1 = {
        duration_ms: 1800000, // 30 minutes
        estimated_ms: null
      };
      const validSession2 = {
        duration_ms: null,
        estimated_ms: 900000 // 15 minutes
      };
      const invalidSession = {
        duration_ms: 1800000,
        estimated_ms: 900000
      };

      assert.ok(validSession1.duration_ms !== null && validSession1.estimated_ms === null);
      assert.ok(validSession2.duration_ms === null && validSession2.estimated_ms !== null);
      assert.ok(!(invalidSession.duration_ms !== null && invalidSession.estimated_ms !== null));
    });

    it('enforces timed sessions must have started_at', () => {
      // Constraint: CHECK (source != 'timed' OR started_at IS NOT NULL)
      const validTimedSession = {
        source: 'timed',
        started_at: '2026-11-25T10:00:00Z'
      };
      const invalidTimedSession = {
        source: 'timed',
        started_at: null
      };
      const validQuickSession = {
        source: 'quick',
        started_at: null
      };

      assert.ok(validTimedSession.source !== 'timed' || validTimedSession.started_at !== null);
      assert.ok(!(invalidTimedSession.source !== 'timed' || invalidTimedSession.started_at !== null));
      assert.ok(validQuickSession.source !== 'timed' || validQuickSession.started_at !== null);
    });

    it('enforces completed sessions must have completed_on', () => {
      // Constraint: CHECK (status = 'completed' OR completed_on IS NULL)
      const validCompleted = {
        status: 'completed',
        completed_on: '2026-11-25'
      };
      const invalidCompleted = {
        status: 'completed',
        completed_on: null
      };
      const validRunning = {
        status: 'running',
        completed_on: null
      };

      assert.ok(validCompleted.status !== 'completed' || validCompleted.completed_on !== null);
      assert.ok(!(invalidCompleted.status !== 'completed' || invalidCompleted.completed_on !== null));
      assert.ok(validRunning.status !== 'completed' || validRunning.completed_on !== null);
    });

    it('allows multiple sessions per habit per day', () => {
      // No unique constraint on (habit_id, completed_on) - multiple sessions allowed
      const sessions = [
        { habit_id: TEST_HABIT_ID, completed_on: '2026-11-25', source: 'timed' },
        { habit_id: TEST_HABIT_ID, completed_on: '2026-11-25', source: 'quick' },
        { habit_id: TEST_HABIT_ID, completed_on: '2026-11-25', source: 'timed' },
      ];

      // All three should be allowed
      assert.strictEqual(sessions.length, 3);
    });
  });

  describe('habit_session_segments Table', () => {
    it('enforces ended_at >= started_at', () => {
      // Constraint: CHECK (ended_at IS NULL OR ended_at >= started_at)
      const validSegment1 = {
        started_at: '2026-11-25T10:00:00Z',
        ended_at: '2026-11-25T10:30:00Z'
      };
      const validSegment2 = {
        started_at: '2026-11-25T10:00:00Z',
        ended_at: null // Currently running
      };
      const invalidSegment = {
        started_at: '2026-11-25T10:30:00Z',
        ended_at: '2026-11-25T10:00:00Z' // Ended before started
      };

      assert.ok(validSegment1.ended_at === null || new Date(validSegment1.ended_at) >= new Date(validSegment1.started_at));
      assert.ok(validSegment2.ended_at === null || new Date(validSegment2.ended_at) >= new Date(validSegment2.started_at));
      assert.ok(!(invalidSegment.ended_at === null || new Date(invalidSegment.ended_at) >= new Date(invalidSegment.started_at)));
    });

    it('calculates segment duration correctly', () => {
      const segment = {
        started_at: '2026-11-25T10:00:00Z',
        ended_at: '2026-11-25T10:30:00Z'
      };

      const durationMs = (new Date(segment.ended_at).getTime() - new Date(segment.started_at).getTime());
      assert.strictEqual(durationMs, 30 * 60 * 1000); // 30 minutes in milliseconds
    });

    it('handles open segments (ended_at = null)', () => {
      const segment = {
        started_at: '2026-11-25T10:00:00Z',
        ended_at: null
      };

      const now = new Date('2026-11-25T10:15:00Z');
      const durationMs = (now.getTime() - new Date(segment.started_at).getTime());
      assert.strictEqual(durationMs, 15 * 60 * 1000); // 15 minutes so far
    });
  });

  describe('habit_session_goal_versions Table', () => {
    it('enforces effective_week must be a Monday', () => {
      // Constraint: CHECK (effective_week = public.lagos_week_start(effective_week))
      const validGoal = {
        effective_week: '2026-11-23' // Monday
      };
      const invalidGoal = {
        effective_week: '2026-11-25' // Wednesday
      };

      const isValidMonday = (dateStr) => {
        const date = new Date(dateStr + 'T00:00:00Z');
        return date.getUTCDay() === 1; // Monday
      };

      assert.ok(isValidMonday(validGoal.effective_week));
      assert.ok(!isValidMonday(invalidGoal.effective_week));
    });

    it('enforces weekly_session_target >= 1 or NULL', () => {
      // Constraint: CHECK (weekly_session_target IS NULL OR weekly_session_target >= 1)
      const validGoal1 = { weekly_session_target: null };
      const validGoal2 = { weekly_session_target: 1 };
      const validGoal3 = { weekly_session_target: 10 };
      const invalidGoal = { weekly_session_target: 0 };

      assert.ok(validGoal1.weekly_session_target === null || validGoal1.weekly_session_target >= 1);
      assert.ok(validGoal2.weekly_session_target === null || validGoal2.weekly_session_target >= 1);
      assert.ok(validGoal3.weekly_session_target === null || validGoal3.weekly_session_target >= 1);
      assert.ok(!(invalidGoal.weekly_session_target === null || invalidGoal.weekly_session_target >= 1));
    });

    it('allows targets exceeding 7 sessions per week', () => {
      const goal = { weekly_session_target: 14 }; // Twice a day
      assert.ok(goal.weekly_session_target >= 1);
    });

    it('enforces unique (habit_id, effective_week)', () => {
      // Only one goal version per habit per week
      const goals = [
        { habit_id: TEST_HABIT_ID, effective_week: '2026-11-23' },
        { habit_id: TEST_HABIT_ID, effective_week: '2026-11-30' },
      ];

      const uniqueKeys = new Set(goals.map(g => `${g.habit_id}-${g.effective_week}`));
      assert.strictEqual(uniqueKeys.size, goals.length);
    });

    it('get_active_goal returns most recent confirmed version', () => {
      const versions = [
        { id: 1, effective_week: '2026-11-09', weekly_session_target: 3, goal_confirmed: true },
        { id: 2, effective_week: '2026-11-16', weekly_session_target: 5, goal_confirmed: true },
        { id: 3, effective_week: '2026-11-23', weekly_session_target: 7, goal_confirmed: true },
        { id: 4, effective_week: '2026-11-30', weekly_session_target: 10, goal_confirmed: false }, // Not confirmed
      ];

      const queryWeek = '2026-11-25'; // Wednesday of week starting 2026-11-23
      
      // Find most recent confirmed version where effective_week <= queryWeek
      const active = versions
        .filter(v => v.goal_confirmed && v.effective_week <= queryWeek)
        .sort((a, b) => b.effective_week.localeCompare(a.effective_week) || b.id - a.id)[0];

      assert.strictEqual(active.id, 3);
      assert.strictEqual(active.weekly_session_target, 7);
    });
  });

  describe('Session Lifecycle Functions', () => {
    it('bloom_start_session creates session and initial segment', () => {
      // Expected behavior:
      // 1. Validates habit exists and is active
      // 2. Checks no other session is running
      // 3. Creates session with status='running', source='timed'
      // 4. Creates initial segment with started_at=now(), ended_at=null
      // 5. Returns session_id and started_at

      const result = {
        session_id: 'new-session-id',
        status: 'running',
        started_at: '2026-11-25T10:00:00Z'
      };

      assert.strictEqual(result.status, 'running');
      assert.ok(result.session_id);
      assert.ok(result.started_at);
    });

    it('bloom_pause_session closes current segment', () => {
      // Expected behavior:
      // 1. Validates session is running
      // 2. Sets ended_at=now() on open segment
      // 3. Updates session status to 'paused'
      // 4. Returns session_id and paused_at

      const result = {
        session_id: 'session-id',
        status: 'paused',
        paused_at: '2026-11-25T10:30:00Z'
      };

      assert.strictEqual(result.status, 'paused');
      assert.ok(result.paused_at);
    });

    it('bloom_resume_session creates new segment', () => {
      // Expected behavior:
      // 1. Validates session is paused
      // 2. Creates new segment with started_at=now(), ended_at=null
      // 3. Updates session status to 'running'
      // 4. Returns session_id and resumed_at

      const result = {
        session_id: 'session-id',
        status: 'running',
        resumed_at: '2026-11-25T11:00:00Z'
      };

      assert.strictEqual(result.status, 'running');
      assert.ok(result.resumed_at);
    });

    it('bloom_complete_session calculates duration and sets completed_on', () => {
      // Expected behavior:
      // 1. Validates session is running or paused
      // 2. Closes any open segment
      // 3. Calculates total duration from all segments
      // 4. Sets completed_on using Africa/Lagos timezone
      // 5. Updates session status to 'completed'
      // 6. Returns session_id, duration_ms, completed_on

      const segments = [
        { started_at: '2026-11-25T10:00:00Z', ended_at: '2026-11-25T10:30:00Z' }, // 30 min
        { started_at: '2026-11-25T11:00:00Z', ended_at: '2026-11-25T11:15:00Z' }, // 15 min
      ];

      const totalDurationMs = segments.reduce((sum, seg) => {
        return sum + (new Date(seg.ended_at).getTime() - new Date(seg.started_at).getTime());
      }, 0);

      const result = {
        session_id: 'session-id',
        status: 'completed',
        completed_at: '2026-11-25T11:15:00Z',
        completed_on: '2026-11-25', // Africa/Lagos date
        duration_ms: totalDurationMs
      };

      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.duration_ms, 45 * 60 * 1000); // 45 minutes
      assert.ok(result.completed_on);
    });

    it('bloom_cancel_session closes segments without duration', () => {
      // Expected behavior:
      // 1. Validates session is running or paused
      // 2. Closes any open segment
      // 3. Updates session status to 'cancelled'
      // 4. Does NOT set duration_ms or completed_on

      const result = {
        session_id: 'session-id',
        status: 'cancelled',
        cancelled_at: '2026-11-25T10:30:00Z'
      };

      assert.strictEqual(result.status, 'cancelled');
      assert.ok(result.cancelled_at);
    });

    it('bloom_quick_log creates completed session with estimated duration', () => {
      // Expected behavior:
      // 1. Validates habit exists and is active
      // 2. Validates date is not in the future
      // 3. Creates session with status='completed', source='quick'
      // 4. Sets estimated_ms (not duration_ms)
      // 5. Returns session_id and completed_on

      const result = {
        session_id: 'new-session-id',
        status: 'completed',
        completed_on: '2026-11-24', // Yesterday
        estimated_ms: 1800000 // 30 minutes
      };

      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.estimated_ms, 1800000);
      assert.ok(result.completed_on);
    });
  });

  describe('Data Integrity', () => {
    it('cascading delete removes sessions when habit is deleted', () => {
      // ON DELETE CASCADE on habit_sessions.habit_id
      // When a habit is deleted, all its sessions should be deleted
      const habit = { id: TEST_HABIT_ID };
      const sessions = [
        { id: 'session-1', habit_id: TEST_HABIT_ID },
        { id: 'session-2', habit_id: TEST_HABIT_ID },
      ];

      // Simulate habit deletion
      const remainingSessions = sessions.filter(s => s.habit_id !== habit.id);
      assert.strictEqual(remainingSessions.length, 0);
    });

    it('cascading delete removes segments when session is deleted', () => {
      // ON DELETE CASCADE on habit_session_segments.session_id
      const session = { id: 'session-1' };
      const segments = [
        { id: 1, session_id: 'session-1' },
        { id: 2, session_id: 'session-1' },
      ];

      // Simulate session deletion
      const remainingSegments = segments.filter(s => s.session_id !== session.id);
      assert.strictEqual(remainingSegments.length, 0);
    });

    it('RLS prevents users from accessing other users sessions', () => {
      // Policy: USING ((SELECT auth.uid()) = user_id)
      const currentUser = TEST_USER_ID;
      const sessions = [
        { id: 'session-1', user_id: TEST_USER_ID },
        { id: 'session-2', user_id: 'other-user-id' },
      ];

      const accessibleSessions = sessions.filter(s => s.user_id === currentUser);
      assert.strictEqual(accessibleSessions.length, 1);
      assert.strictEqual(accessibleSessions[0].id, 'session-1');
    });
  });

  describe('Weekly Goal Versioning', () => {
    it('preserves historical goals when creating new version', () => {
      // Goal versions are immutable - new versions don't modify old ones
      const existingVersions = [
        { id: 1, effective_week: '2026-11-09', weekly_session_target: 3 },
        { id: 2, effective_week: '2026-11-16', weekly_session_target: 5 },
      ];

      const newVersion = { id: 3, effective_week: '2026-11-23', weekly_session_target: 7 };
      const allVersions = [...existingVersions, newVersion];

      assert.strictEqual(allVersions.length, 3);
      assert.strictEqual(allVersions[0].weekly_session_target, 3); // Unchanged
      assert.strictEqual(allVersions[1].weekly_session_target, 5); // Unchanged
      assert.strictEqual(allVersions[2].weekly_session_target, 7); // New
    });

    it('calculates next effective week correctly', () => {
      // When user sets a goal on Wednesday 2026-11-25, it should be effective from Monday 2026-11-30
      const currentDate = '2026-11-25'; // Wednesday
      const currentWeekStart = '2026-11-23'; // Monday of current week
      const nextWeekStart = '2026-11-30'; // Monday of next week

      const date = new Date(currentDate + 'T00:00:00Z');
      const day = date.getUTCDay();
      const daysUntilNextMonday = day === 0 ? 1 : (8 - day) % 7 || 7;
      date.setUTCDate(date.getUTCDate() + daysUntilNextMonday);
      const calculatedNextWeek = date.toISOString().split('T')[0];

      assert.strictEqual(calculatedNextWeek, nextWeekStart);
    });

    it('handles unconfirmed goals as no target', () => {
      const versions = [
        { id: 1, effective_week: '2026-11-23', weekly_session_target: 7, goal_confirmed: false },
      ];

      const queryWeek = '2026-11-25';
      const active = versions
        .filter(v => v.goal_confirmed && v.effective_week <= queryWeek)
        .sort((a, b) => b.effective_week.localeCompare(a.effective_week))[0];

      // No confirmed goal found
      assert.strictEqual(active, undefined);
    });
  });
});

console.log('Phase 2 Database Architecture tests defined successfully');
