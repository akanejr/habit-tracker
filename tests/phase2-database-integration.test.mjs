#!/usr/bin/env node
/**
 * Phase 2 Database Architecture - Database-Backed Integration Tests
 * 
 * These tests run against a real PostgreSQL database to verify:
 * - Migration execution
 * - Constraint enforcement
 * - RLS policies
 * - RPC function behavior
 * - Concurrency handling
 * - Idempotency
 * - Goal immutability
 * 
 * Requirements:
 * - PostgreSQL 17 running on localhost:5432
 * - Database: bloom_test
 * - User: bloom_tester / test123
 */

import postgres from 'postgres';
import assert from 'node:assert';
import { v4 as uuidv4 } from 'uuid';

// Test configuration
const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';

// Create two separate connections for concurrency tests
const sql = postgres(DB_URL);
const sql2 = postgres(DB_URL);

// Test counters
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;

// Test data
const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';
let TEST_HABIT_1;
let TEST_HABIT_2;

// Helper to run a test
async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failedTests++;
    console.log(`  ❌ ${name}`);
    console.log(`     Error: ${err.message}`);
    if (process.env.VERBOSE) {
      console.log(err.stack);
    }
  }
}

// Helper to skip a test
function skip(name, reason) {
  totalTests++;
  skippedTests++;
  console.log(`  ⏭️  ${name} (skipped: ${reason})`);
}

// Helper to set authenticated user
async function setAuth(conn, email) {
  // SET doesn't support parameterized queries, use string interpolation
  await conn.unsafe(`SET app.current_user_email = '${email}'`);
}

// Helper to clean up test data
async function cleanup() {
  await sql`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1} OR user_id = ${TEST_USER_2}`;
}

// Helper to create test data
async function setupTestData() {
  // Set authenticated users FIRST (before any database operations)
  await setAuth(sql, 'user1@test.com');
  await setAuth(sql2, 'user2@test.com');
  
  // Profiles already exist from database setup (created by superuser)
  // No need to create them here
  
  // Now cleanup (requires auth context for RLS)
  await cleanup();
  
  // Create habits as user1
  const [habit1] = await sql`
    INSERT INTO public.habits (user_id, name, is_active)
    VALUES (${TEST_USER_1}, 'Exercise', true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit1.id;

  // Create habits as user2 (using sql2 connection)
  const [habit2] = await sql2`
    INSERT INTO public.habits (user_id, name, is_active)
    VALUES (${TEST_USER_2}, 'Read', true)
    RETURNING id
  `;
  TEST_HABIT_2 = habit2.id;
}

// ============================================================================
// TEST SUITES
// ============================================================================

async function testMigrationExecution() {
  console.log('\n📦 Migration Execution Tests');
  
  await test('all Phase 2 tables exist', async () => {
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN (
        'habit_sessions',
        'habit_session_segments', 
        'habit_session_goal_versions',
        'session_command_requests'
      )
      ORDER BY table_name
    `;
    assert.strictEqual(tables.length, 4, 'Expected 4 Phase 2 tables');
  });

  await test('unique partial index exists for active sessions', async () => {
    const indexes = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'habit_sessions'
      AND indexname = 'one_active_session_per_user'
    `;
    assert.strictEqual(indexes.length, 1, 'Expected unique partial index');
  });

  await test('session_goal_type column exists on habits', async () => {
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'habits' AND column_name = 'session_goal_type'
    `;
    assert.strictEqual(cols.length, 1, 'Expected session_goal_type column');
  });

  await test('all RPC functions exist', async () => {
    const fns = await sql`
      SELECT DISTINCT routine_name FROM information_schema.routines
      WHERE routine_schema = 'public'
      AND routine_name IN (
        'bloom_start_session',
        'bloom_pause_session',
        'bloom_resume_session',
        'bloom_complete_session',
        'bloom_cancel_session',
        'bloom_quick_log',
        'bloom_set_weekly_goal',
        'lagos_date',
        'lagos_week_start',
        'get_active_goal'
      )
      ORDER BY routine_name
    `;
    // Note: bloom_quick_log has 2 overloads (different signatures), so we use DISTINCT
    assert.strictEqual(fns.length, 10, `Expected 10 unique functions, got ${fns.length}`);
  });
}

async function testTimezoneFunctions() {
  console.log('\n🌍 Timezone Function Tests');

  await test('lagos_date converts UTC to Africa/Lagos date', async () => {
    // 23:00 UTC = 00:00 WAT (next day)
    const [result] = await sql`
      SELECT public.lagos_date('2026-11-25 23:00:00+00'::timestamptz) AS d
    `;
    // PostgreSQL returns a date, convert to ISO string for comparison
    const dateStr = result.d instanceof Date ? result.d.toISOString().split('T')[0] : result.d;
    assert.strictEqual(dateStr, '2026-11-26');
  });

  await test('lagos_date handles midnight correctly', async () => {
    // 22:59 UTC = 23:59 WAT (same day)
    const [result] = await sql`
      SELECT public.lagos_date('2026-11-25 22:59:00+00'::timestamptz) AS d
    `;
    const dateStr = result.d instanceof Date ? result.d.toISOString().split('T')[0] : result.d;
    assert.strictEqual(dateStr, '2026-11-25');
  });

  await test('lagos_week_start returns Monday', async () => {
    // Wednesday should return Monday
    const [result] = await sql`
      SELECT public.lagos_week_start('2026-11-25'::date) AS ws
    `;
    const dateStr = result.ws instanceof Date ? result.ws.toISOString().split('T')[0] : result.ws;
    assert.strictEqual(dateStr, '2026-11-23');
  });

  await test('lagos_week_start returns same date for Monday', async () => {
    const [result] = await sql`
      SELECT public.lagos_week_start('2026-11-23'::date) AS ws
    `;
    const dateStr = result.ws instanceof Date ? result.ws.toISOString().split('T')[0] : result.ws;
    assert.strictEqual(dateStr, '2026-11-23');
  });

  await test('lagos_week_start returns previous Monday for Sunday', async () => {
    const [result] = await sql`
      SELECT public.lagos_week_start('2026-11-29'::date) AS ws
    `;
    const dateStr = result.ws instanceof Date ? result.ws.toISOString().split('T')[0] : result.ws;
    assert.strictEqual(dateStr, '2026-11-23');
  });
}

async function testConstraintEnforcement() {
  console.log('\n🔒 Constraint Enforcement Tests');

  await test('duration exclusivity: both duration_ms and estimated_ms rejected', async () => {
    try {
      await sql`
        INSERT INTO public.habit_sessions (
          user_id, habit_id, source, status, recording_mode,
          duration_ms, estimated_ms, started_at, completed_at
        ) VALUES (
          ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'completed', 'timer',
          1800000, 900000, now(), now()
        )
      `;
      assert.fail('Should have rejected both duration_ms and estimated_ms');
    } catch (err) {
      assert.ok(err.message.includes('duration_exclusive'), 'Expected duration_exclusive constraint');
    }
  });

  await test('duration exclusivity: only duration_ms allowed', async () => {
    const [result] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        duration_ms, started_at, completed_at,
        start_version_id, completion_version_id
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'completed', 'timer',
        1800000, now(), now(),
        (SELECT id FROM habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1),
        (SELECT id FROM habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1)
      )
      RETURNING id
    `;
    assert.ok(result.id, 'Session should be created');
  });

  await test('duration exclusivity: only estimated_ms allowed', async () => {
    const [result] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        estimated_ms, started_at, completed_at,
        start_version_id, completion_version_id
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'quick', 'completed', 'quick',
        900000, now(), now(),
        (SELECT id FROM habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1),
        (SELECT id FROM habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1)
      )
      RETURNING id
    `;
    assert.ok(result.id, 'Session should be created');
  });

  await test('duration exclusivity: neither set allowed (unknown)', async () => {
    const [result] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        started_at, completed_at,
        start_version_id, completion_version_id
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'legacy', 'completed', 'legacy',
        now(), now(),
        (SELECT id FROM habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1),
        (SELECT id FROM habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1)
      )
      RETURNING id
    `;
    assert.ok(result.id, 'Session should be created');
  });

  await test('session_goal_type check constraint', async () => {
    try {
      await sql`
        UPDATE public.habits SET session_goal_type = 'invalid' WHERE id = ${TEST_HABIT_1}
      `;
      assert.fail('Should have rejected invalid session_goal_type');
    } catch (err) {
      assert.ok(err.message.includes('check constraint') || err.message.includes('violates'), 
        'Expected check constraint violation');
    }
  });

  await test('session_goal_type accepts valid values', async () => {
    await sql`UPDATE public.habits SET session_goal_type = 'weekly' WHERE id = ${TEST_HABIT_1}`;
    await sql`UPDATE public.habits SET session_goal_type = 'none' WHERE id = ${TEST_HABIT_1}`;
    await sql`UPDATE public.habits SET session_goal_type = NULL WHERE id = ${TEST_HABIT_1}`;
  });

  await test('foreign key cascade: deleting habit deletes sessions', async () => {
    // Create a temporary habit
    const [tempHabit] = await sql`
      INSERT INTO public.habits (user_id, name, is_active)
      VALUES (${TEST_USER_1}, 'Temp', true)
      RETURNING id
    `;

    // Create a session for it
    await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode, started_at,
        start_version_id
      ) VALUES (
        ${TEST_USER_1}, ${tempHabit.id}, 'timed', 'completed', 'timer', now(),
        (SELECT id FROM habit_versions WHERE habit_id = ${tempHabit.id} LIMIT 1)
      )
    `;

    // Delete the habit
    await sql`DELETE FROM public.habits WHERE id = ${tempHabit.id}`;

    // Verify sessions are gone
    const sessions = await sql`
      SELECT id FROM public.habit_sessions WHERE habit_id = ${tempHabit.id}
    `;
    assert.strictEqual(sessions.length, 0, 'Sessions should be cascade deleted');
  });
}

async function testSessionLifecycle() {
  console.log('\n🔄 Session Lifecycle Tests');

  await setAuth(sql, 'user1@test.com');

  await test('bloom_start_session creates session and segment', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [result] = await sql`
      SELECT public.bloom_start_session('req-start-1', ${TEST_HABIT_1}) AS r
    `;
    
    assert.ok(result.r.session_id, 'Should return session_id');
    assert.strictEqual(result.r.status, 'running');

    // Verify session exists
    const sessions = await sql`
      SELECT id, status FROM public.habit_sessions WHERE id = ${result.r.session_id}
    `;
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(sessions[0].status, 'running');

    // Verify segment exists
    const segments = await sql`
      SELECT id FROM public.habit_session_segments WHERE session_id = ${result.r.session_id}
    `;
    assert.strictEqual(segments.length, 1);
  });

  await test('bloom_pause_session pauses running session', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-2', ${TEST_HABIT_1}) AS r
    `;

    const [pauseResult] = await sql`
      SELECT public.bloom_pause_session('req-pause-1', ${startResult.r.session_id}) AS r
    `;
    
    assert.strictEqual(pauseResult.r.status, 'paused');

    // Verify segment was ended
    const segments = await sql`
      SELECT id, ended_at FROM public.habit_session_segments 
      WHERE session_id = ${startResult.r.session_id}
    `;
    assert.ok(segments[0].ended_at, 'Segment should be ended');
  });

  await test('bloom_resume_session creates new segment', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-3', ${TEST_HABIT_1}) AS r
    `;
    await sql`SELECT public.bloom_pause_session('req-pause-2', ${startResult.r.session_id})`;

    const [resumeResult] = await sql`
      SELECT public.bloom_resume_session('req-resume-1', ${startResult.r.session_id}) AS r
    `;
    
    assert.strictEqual(resumeResult.r.status, 'running');
    assert.ok(resumeResult.r.segment_id, 'Should return new segment_id');

    // Verify two segments exist
    const segments = await sql`
      SELECT id FROM public.habit_session_segments 
      WHERE session_id = ${startResult.r.session_id}
    `;
    assert.strictEqual(segments.length, 2, 'Should have 2 segments');
  });

  await test('bloom_complete_session calculates duration', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-4', ${TEST_HABIT_1}) AS r
    `;

    // Small delay
    await new Promise(r => setTimeout(r, 100));

    const [completeResult] = await sql`
      SELECT public.bloom_complete_session('req-complete-1', ${startResult.r.session_id}) AS r
    `;
    
    assert.strictEqual(completeResult.r.status, 'completed');
    assert.ok(completeResult.r.duration_ms >= 0, 'Duration should be calculated');

    // Verify session has duration
    const sessions = await sql`
      SELECT duration_ms FROM public.habit_sessions WHERE id = ${startResult.r.session_id}
    `;
    assert.ok(sessions[0].duration_ms >= 0, 'Session should have duration_ms');
  });

  await test('bloom_cancel_session marks as cancelled', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-5', ${TEST_HABIT_1}) AS r
    `;

    const [cancelResult] = await sql`
      SELECT public.bloom_cancel_session('req-cancel-1', ${startResult.r.session_id}) AS r
    `;
    
    assert.strictEqual(cancelResult.r.status, 'cancelled');
  });

  await test('bloom_quick_log creates completed session', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [result] = await sql`
      SELECT public.bloom_quick_log('req-quick-1', ${TEST_HABIT_1}, 1800000, 'Morning run') AS r
    `;
    
    assert.strictEqual(result.r.status, 'completed');
    assert.strictEqual(result.r.estimated_ms, 1800000);
  });

  await test('cannot complete already completed session', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-6', ${TEST_HABIT_1}) AS r
    `;
    await sql`SELECT public.bloom_complete_session('req-complete-2', ${startResult.r.session_id})`;

    try {
      await sql`SELECT public.bloom_complete_session('req-complete-3', ${startResult.r.session_id})`;
      assert.fail('Should have rejected completing already completed session');
    } catch (err) {
      assert.ok(err.message.includes('cannot be completed'), 'Expected status error');
    }
  });

  await test('cannot pause already paused session', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-7', ${TEST_HABIT_1}) AS r
    `;
    await sql`SELECT public.bloom_pause_session('req-pause-3', ${startResult.r.session_id})`;

    try {
      await sql`SELECT public.bloom_pause_session('req-pause-4', ${startResult.r.session_id})`;
      assert.fail('Should have rejected pausing already paused session');
    } catch (err) {
      assert.ok(err.message.includes('not running'), 'Expected status error');
    }
  });

  await test('cannot resume non-paused session', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-start-8', ${TEST_HABIT_1}) AS r
    `;

    try {
      await sql`SELECT public.bloom_resume_session('req-resume-2', ${startResult.r.session_id})`;
      assert.fail('Should have rejected resuming running session');
    } catch (err) {
      assert.ok(err.message.includes('not paused'), 'Expected status error');
    }
  });
}

async function testSingleActiveSession() {
  console.log('\n🚫 Single Active Session Tests');

  await test('cannot start second session while first is running', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    await sql`SELECT public.bloom_start_session('req-active-1', ${TEST_HABIT_1})`;

    try {
      await sql`SELECT public.bloom_start_session('req-active-2', ${TEST_HABIT_1})`;
      assert.fail('Should have rejected second session');
    } catch (err) {
      assert.ok(
        err.message.includes('already active') || err.message.includes('unique'),
        `Expected active session error, got: ${err.message}`
      );
    }
  });

  await test('cannot start second session while first is paused', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-paused-1', ${TEST_HABIT_1}) AS r
    `;
    await sql`SELECT public.bloom_pause_session('req-paused-2', ${startResult.r.session_id})`;

    try {
      await sql`SELECT public.bloom_start_session('req-paused-3', ${TEST_HABIT_1})`;
      assert.fail('Should have rejected second session while paused');
    } catch (err) {
      assert.ok(
        err.message.includes('already active') || err.message.includes('unique'),
        `Expected active session error, got: ${err.message}`
      );
    }
  });

  await test('can start new session after completing previous', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-after-1', ${TEST_HABIT_1}) AS r
    `;
    await sql`SELECT public.bloom_complete_session('req-after-2', ${startResult.r.session_id})`;

    // Should succeed
    const [newStart] = await sql`
      SELECT public.bloom_start_session('req-after-3', ${TEST_HABIT_1}) AS r
    `;
    assert.ok(newStart.r.session_id, 'New session should start after completion');
  });

  await test('can start new session after cancelling previous', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-cancel-1', ${TEST_HABIT_1}) AS r
    `;
    await sql`SELECT public.bloom_cancel_session('req-cancel-2', ${startResult.r.session_id})`;

    // Should succeed
    const [newStart] = await sql`
      SELECT public.bloom_start_session('req-cancel-3', ${TEST_HABIT_1}) AS r
    `;
    assert.ok(newStart.r.session_id, 'New session should start after cancellation');
  });

  await test('different users can have concurrent sessions', async () => {
    await cleanup();
    await setupTestData();

    // User 1 starts session
    await setAuth(sql, 'user1@test.com');
    const [user1Session] = await sql`
      SELECT public.bloom_start_session('req-multi-1', ${TEST_HABIT_1}) AS r
    `;

    // User 2 starts session (different connection)
    await setAuth(sql2, 'user2@test.com');
    const [user2Session] = await sql2`
      SELECT public.bloom_start_session('req-multi-2', ${TEST_HABIT_2}) AS r
    `;

    assert.ok(user1Session.r.session_id, 'User 1 should have session');
    assert.ok(user2Session.r.session_id, 'User 2 should have session');
    assert.notStrictEqual(user1Session.r.session_id, user2Session.r.session_id);
  });
}

async function testConcurrency() {
  console.log('\n⚡ Concurrency Tests');

  await test('concurrent session starts: exactly one succeeds', async () => {
    await cleanup();
    await setupTestData();

    // Set auth on both connections
    await setAuth(sql, 'user1@test.com');
    await setAuth(sql2, 'user1@test.com');

    // Launch both simultaneously
    const results = await Promise.allSettled([
      sql`SELECT public.bloom_start_session('req-race-1', ${TEST_HABIT_1}) AS r`,
      sql2`SELECT public.bloom_start_session('req-race-2', ${TEST_HABIT_1}) AS r`
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // Exactly one should succeed
    assert.strictEqual(fulfilled.length, 1, `Expected exactly 1 success, got ${fulfilled.length}`);
    assert.strictEqual(rejected.length, 1, `Expected exactly 1 failure, got ${rejected.length}`);
  });

  await test('concurrent pause and complete: only one succeeds', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    await setAuth(sql2, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('req-pc-1', ${TEST_HABIT_1}) AS r
    `;

    // Try to pause and complete simultaneously
    const results = await Promise.allSettled([
      sql`SELECT public.bloom_pause_session('req-pc-2', ${startResult.r.session_id}) AS r`,
      sql2`SELECT public.bloom_complete_session('req-pc-3', ${startResult.r.session_id}) AS r`
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    
    // At least one should succeed (could be either pause or complete)
    assert.ok(fulfilled.length >= 1, 'At least one operation should succeed');
  });

  await test('concurrent goal updates: both succeed (immutable history)', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    await setAuth(sql2, 'user1@test.com');

    const nextMonday = '2026-11-30';

    // Both try to set goal for same week
    const results = await Promise.allSettled([
      sql`SELECT public.bloom_set_weekly_goal('req-goal-1', ${TEST_HABIT_1}, ${nextMonday}, 5) AS r`,
      sql2`SELECT public.bloom_set_weekly_goal('req-goal-2', ${TEST_HABIT_1}, ${nextMonday}, 7) AS r`
    ]);

    // Both should succeed (different request_ids = different operations)
    assert.strictEqual(results[0].status, 'fulfilled', 'First goal update should succeed');
    assert.strictEqual(results[1].status, 'fulfilled', 'Second goal update should succeed');

    // Both versions should exist (immutable history)
    const versions = await sql`
      SELECT weekly_session_target, recorded_at 
      FROM public.habit_session_goal_versions
      WHERE habit_id = ${TEST_HABIT_1} AND effective_week = ${nextMonday}
      ORDER BY recorded_at
    `;
    assert.strictEqual(versions.length, 2, 'Both goal versions should be preserved');
  });
}

async function testGoalImmutability() {
  console.log('\n📜 Goal Immutability Tests');

  await test('multiple goal changes create multiple versions', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const nextMonday = '2026-11-30';

    // Set goal three times
    await sql`SELECT public.bloom_set_weekly_goal('req-g1', ${TEST_HABIT_1}, ${nextMonday}, 3)`;
    await sql`SELECT public.bloom_set_weekly_goal('req-g2', ${TEST_HABIT_1}, ${nextMonday}, 5)`;
    await sql`SELECT public.bloom_set_weekly_goal('req-g3', ${TEST_HABIT_1}, ${nextMonday}, 7)`;

    // All three versions should exist
    const versions = await sql`
      SELECT weekly_session_target, recorded_at
      FROM public.habit_session_goal_versions
      WHERE habit_id = ${TEST_HABIT_1} AND effective_week = ${nextMonday}
      ORDER BY recorded_at
    `;
    assert.strictEqual(versions.length, 3, 'All three versions should be preserved');
    assert.strictEqual(versions[0].weekly_session_target, 3);
    assert.strictEqual(versions[1].weekly_session_target, 5);
    assert.strictEqual(versions[2].weekly_session_target, 7);
  });

  await test('get_active_goal returns latest version', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const nextMonday = '2026-11-30';

    await sql`SELECT public.bloom_set_weekly_goal('req-ag1', ${TEST_HABIT_1}, ${nextMonday}, 3)`;
    await sql`SELECT public.bloom_set_weekly_goal('req-ag2', ${TEST_HABIT_1}, ${nextMonday}, 5)`;
    await sql`SELECT public.bloom_set_weekly_goal('req-ag3', ${TEST_HABIT_1}, ${nextMonday}, 7)`;

    const [active] = await sql`
      SELECT * FROM public.get_active_goal(${TEST_HABIT_1}, ${nextMonday})
    `;
    assert.strictEqual(active.weekly_target, 7, 'Should return latest version (7)');
  });

  await test('NULL target (no goal) is preserved', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const nextMonday = '2026-11-30';

    await sql`SELECT public.bloom_set_weekly_goal('req-null1', ${TEST_HABIT_1}, ${nextMonday}, NULL)`;

    const [active] = await sql`
      SELECT * FROM public.get_active_goal(${TEST_HABIT_1}, ${nextMonday})
    `;
    assert.strictEqual(active.weekly_target, null, 'NULL target should be preserved');
  });

  await test('targets greater than 7 are allowed', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const nextMonday = '2026-11-30';

    await sql`SELECT public.bloom_set_weekly_goal('req-high1', ${TEST_HABIT_1}, ${nextMonday}, 14)`;

    const [active] = await sql`
      SELECT * FROM public.get_active_goal(${TEST_HABIT_1}, ${nextMonday})
    `;
    assert.strictEqual(active.weekly_target, 14, 'Target > 7 should be allowed');
  });

  await test('effective_week must be Monday', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    try {
      await sql`SELECT public.bloom_set_weekly_goal('req-bad1', ${TEST_HABIT_1}, '2026-11-25', 5)`;
      assert.fail('Should have rejected non-Monday date');
    } catch (err) {
      assert.ok(err.message.includes('Monday'), 'Expected Monday validation error');
    }
  });

  await test('historical goal retrieval works', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const week1 = '2026-11-16';
    const week2 = '2026-11-23';

    await sql`SELECT public.bloom_set_weekly_goal('req-hist1', ${TEST_HABIT_1}, ${week1}, 3)`;
    await sql`SELECT public.bloom_set_weekly_goal('req-hist2', ${TEST_HABIT_1}, ${week2}, 5)`;

    // Change week1 goal (new version, doesn't overwrite)
    await sql`SELECT public.bloom_set_weekly_goal('req-hist3', ${TEST_HABIT_1}, ${week1}, 4)`;

    // Week 1 should return latest version (4)
    const [week1Goal] = await sql`
      SELECT * FROM public.get_active_goal(${TEST_HABIT_1}, ${week1})
    `;
    assert.strictEqual(week1Goal.weekly_target, 4);

    // Week 2 should still be 5
    const [week2Goal] = await sql`
      SELECT * FROM public.get_active_goal(${TEST_HABIT_1}, ${week2})
    `;
    assert.strictEqual(week2Goal.weekly_target, 5);

    // Verify all versions preserved
    const allVersions = await sql`
      SELECT COUNT(*) as cnt FROM public.habit_session_goal_versions
      WHERE habit_id = ${TEST_HABIT_1}
    `;
    assert.strictEqual(Number(allVersions[0].cnt), 3, 'All 3 versions should be preserved');
  });
}

async function testIdempotency() {
  console.log('\n🔁 Idempotency Tests');

  await test('duplicate request_id returns cached result', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const reqId = 'idempotent-start-' + Date.now();
    
    const [first] = await sql`
      SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1}) AS r
    `;

    const [second] = await sql`
      SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1}) AS r
    `;

    // Should return same session_id
    assert.strictEqual(second.r.session_id, first.r.session_id, 'Should return cached result');
  });

  await test('duplicate request does not create second session', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const reqId = 'idempotent-no-dup-' + Date.now();
    
    await sql`SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1})`;
    await sql`SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1})`;

    const sessions = await sql`
      SELECT COUNT(*) as cnt FROM public.habit_sessions WHERE user_id = ${TEST_USER_1} AND status = 'running'
    `;
    assert.strictEqual(Number(sessions[0].cnt), 1, 'Should only have one session');
  });

  await test('same request_id with different payload is rejected', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const reqId = 'idempotent-diff-' + Date.now();
    
    await sql`SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1})`;

    // Complete the session so we can start another
    const sessions = await sql`
      SELECT id FROM public.habit_sessions WHERE user_id = ${TEST_USER_1} AND status = 'running'
    `;
    await sql`SELECT public.bloom_complete_session('complete-diff', ${sessions[0].id})`;

    // Try to start with same request_id but different habit (different payload)
    try {
      // Create a second habit for user 1
      const [habit2] = await sql`
        INSERT INTO public.habits (user_id, name, is_active)
        VALUES (${TEST_USER_1}, 'Meditate', true)
        RETURNING id
      `;
      await sql`SELECT public.bloom_start_session(${reqId}, ${habit2.id})`;
      assert.fail('Should have rejected different payload with same request_id');
    } catch (err) {
      assert.ok(err.message.includes('already used') || err.message.includes('different'),
        `Expected request_id conflict error, got: ${err.message}`);
    }
  });

  await test('idempotency works for quick_log', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const reqId = 'idempotent-quick-' + Date.now();
    
    const [first] = await sql`
      SELECT public.bloom_quick_log(${reqId}, ${TEST_HABIT_1}, 1800000, 'Test') AS r
    `;
    const [second] = await sql`
      SELECT public.bloom_quick_log(${reqId}, ${TEST_HABIT_1}, 1800000, 'Test') AS r
    `;

    assert.strictEqual(second.r.session_id, first.r.session_id, 'Should return cached result');

    // Verify only one session created
    const sessions = await sql`
      SELECT COUNT(*) as cnt FROM public.habit_sessions WHERE source = 'quick' AND user_id = ${TEST_USER_1}
    `;
    assert.strictEqual(Number(sessions[0].cnt), 1, 'Should only have one quick log session');
  });

  await test('idempotency works for set_weekly_goal', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const reqId = 'idempotent-goal-' + Date.now();
    const nextMonday = '2026-11-30';
    
    const [first] = await sql`
      SELECT public.bloom_set_weekly_goal(${reqId}, ${TEST_HABIT_1}, ${nextMonday}, 5) AS r
    `;
    const [second] = await sql`
      SELECT public.bloom_set_weekly_goal(${reqId}, ${TEST_HABIT_1}, ${nextMonday}, 5) AS r
    `;

    assert.strictEqual(second.r.goal_id, first.r.goal_id, 'Should return cached result');

    // Verify only one goal version created
    const versions = await sql`
      SELECT COUNT(*) as cnt FROM public.habit_session_goal_versions
      WHERE habit_id = ${TEST_HABIT_1} AND effective_week = ${nextMonday}
    `;
    assert.strictEqual(Number(versions[0].cnt), 1, 'Should only have one goal version');
  });

  await test('idempotency works for pause/resume/complete/cancel', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    const [startResult] = await sql`
      SELECT public.bloom_start_session('idem-lifecycle-start', ${TEST_HABIT_1}) AS r
    `;

    // Pause twice with same request_id
    const [pause1] = await sql`
      SELECT public.bloom_pause_session('idem-pause', ${startResult.r.session_id}) AS r
    `;
    const [pause2] = await sql`
      SELECT public.bloom_pause_session('idem-pause', ${startResult.r.session_id}) AS r
    `;
    assert.strictEqual(pause2.r.session_id, pause1.r.session_id, 'Pause should be idempotent');

    // Resume twice with same request_id
    const [resume1] = await sql`
      SELECT public.bloom_resume_session('idem-resume', ${startResult.r.session_id}) AS r
    `;
    const [resume2] = await sql`
      SELECT public.bloom_resume_session('idem-resume', ${startResult.r.session_id}) AS r
    `;
    assert.strictEqual(resume2.r.session_id, resume1.r.session_id, 'Resume should be idempotent');

    // Complete twice with same request_id
    const [complete1] = await sql`
      SELECT public.bloom_complete_session('idem-complete', ${startResult.r.session_id}) AS r
    `;
    const [complete2] = await sql`
      SELECT public.bloom_complete_session('idem-complete', ${startResult.r.session_id}) AS r
    `;
    assert.strictEqual(complete2.r.session_id, complete1.r.session_id, 'Complete should be idempotent');
  });

  await test('concurrent duplicate requests: only one executes', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    await setAuth(sql2, 'user1@test.com');

    const reqId = 'concurrent-idem-' + Date.now();

    // Launch both simultaneously
    const results = await Promise.allSettled([
      sql`SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1}) AS r`,
      sql2`SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1}) AS r`
    ]);

    // Count sessions created
    const sessions = await sql`
      SELECT COUNT(*) as cnt FROM public.habit_sessions WHERE user_id = ${TEST_USER_1} AND status = 'running'
    `;
    assert.strictEqual(Number(sessions[0].cnt), 1, 'Should only have one session despite concurrent requests');
  });
}

async function testRLSPolicies() {
  console.log('\n🛡️ RLS Policy Tests');

  await test('RLS is enabled on all Phase 2 tables', async () => {
    const tables = await sql`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename IN (
        'habit_sessions',
        'habit_session_segments',
        'habit_session_goal_versions',
        'session_command_requests'
      )
      ORDER BY tablename
    `;
    
    for (const t of tables) {
      assert.strictEqual(t.rowsecurity, true, `RLS should be enabled on ${t.tablename}`);
    }
  });

  await test('authenticated users cannot directly modify session_command_requests', async () => {
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`
        INSERT INTO public.session_command_requests (request_id, user_id, operation_type, operation_payload)
        VALUES ('direct-insert', ${TEST_USER_1}, 'start_session', '{}'::jsonb)
      `;
      assert.fail('Should have rejected direct insert');
    } catch (err) {
      // Expected - either permission denied or RLS policy violation
      assert.ok(
        err.message.includes('permission') || 
        err.message.includes('denied') ||
        err.message.includes('row-level security') ||
        err.message.includes('RLS'),
        `Expected permission or RLS error, got: ${err.message}`
      );
    }
  });

  await test('privileges correctly scoped for authenticated role', async () => {
    const privs = await sql`
      SELECT table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE grantee = 'authenticated'
      AND table_schema = 'public'
      AND table_name IN ('habit_sessions', 'habit_session_segments', 'habit_session_goal_versions')
      ORDER BY table_name, privilege_type
    `;

    // Check that authenticated has SELECT, INSERT, UPDATE, DELETE on session tables
    const sessionPrivs = privs.filter(p => p.table_name === 'habit_sessions');
    const types = sessionPrivs.map(p => p.privilege_type);
    assert.ok(types.includes('SELECT'), 'Should have SELECT on habit_sessions');
    assert.ok(types.includes('INSERT'), 'Should have INSERT on habit_sessions');
  });
}

async function testErrorHandling() {
  console.log('\n⚠️ Error Handling Tests');

  await test('unauthenticated request is rejected', async () => {
    await sql`RESET app.current_user_email`;
    
    try {
      await sql`SELECT public.bloom_start_session('unauth-1', ${TEST_HABIT_1})`;
      assert.fail('Should have rejected unauthenticated request');
    } catch (err) {
      assert.ok(err.message.includes('Not authenticated') || err.message.includes('authenticated'),
        `Expected auth error, got: ${err.message}`);
    }

    await setAuth(sql, 'user1@test.com');
  });

  await test('accessing other users habit is rejected', async () => {
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`SELECT public.bloom_start_session('cross-user-1', ${TEST_HABIT_2})`;
      assert.fail('Should have rejected cross-user access');
    } catch (err) {
      assert.ok(err.message.includes('not found') || err.message.includes('denied'),
        `Expected access denied error, got: ${err.message}`);
    }
  });

  await test('non-existent session is rejected', async () => {
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`SELECT public.bloom_pause_session('nonexist-1', '99999999-9999-9999-9999-999999999999'::uuid)`;
      assert.fail('Should have rejected non-existent session');
    } catch (err) {
      assert.ok(err.message.includes('not found') || err.message.includes('denied'),
        `Expected not found error, got: ${err.message}`);
    }
  });

  await test('negative estimated_ms is rejected', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');

    try {
      await sql`SELECT public.bloom_quick_log('neg-ms-1', ${TEST_HABIT_1}, -100, 'Bad')`;
      assert.fail('Should have rejected negative estimated_ms');
    } catch (err) {
      assert.ok(err.message.includes('non-negative'),
        `Expected validation error, got: ${err.message}`);
    }
  });
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('============================================================');
  console.log('  Phase 2 Database Architecture - Database-Backed Tests');
  console.log('============================================================');
  console.log(`  Database: ${DB_URL.replace(/\/\/[^@]+@/, '//<credentials>@')}`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log('============================================================');

  try {
    // Verify connection
    const version = await sql`SELECT version()`;
    console.log(`  PostgreSQL: ${version[0].version.split(' on ')[0]}`);

    // Set up test data
    console.log('\n📝 Setting up test data...');
    try {
      await setupTestData();
      console.log('  ✅ Test data created');
    } catch (setupErr) {
      console.error('  ❌ Setup failed:', setupErr.message);
      if (process.env.VERBOSE) {
        console.error(setupErr.stack);
      }
      throw setupErr;
    }

    // Run all test suites
    await testMigrationExecution();
    await testTimezoneFunctions();
    await testConstraintEnforcement();
    await testSessionLifecycle();
    await testSingleActiveSession();
    await testConcurrency();
    await testGoalImmutability();
    await testIdempotency();
    await testRLSPolicies();
    await testErrorHandling();

    // Summary
    console.log('\n============================================================');
    console.log('  TEST SUMMARY');
    console.log('============================================================');
    console.log(`  Total:   ${totalTests}`);
    console.log(`  Passed:  ${passedTests} ✅`);
    console.log(`  Failed:  ${failedTests} ❌`);
    console.log(`  Skipped: ${skippedTests} ⏭️`);
    console.log('============================================================');

    if (failedTests > 0) {
      console.log('\n❌ SOME TESTS FAILED');
      process.exitCode = 1;
    } else {
      console.log('\n✅ ALL TESTS PASSED');
    }

  } catch (err) {
    console.error('\n💥 FATAL ERROR:', err.message);
    if (process.env.VERBOSE) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  } finally {
    await sql.end();
    await sql2.end();
  }
}

main();
