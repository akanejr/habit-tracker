#!/usr/bin/env node
/**
 * Phase 5: Stale Session Recovery & Data Integrity Tests
 *
 * Stale Session Tests:
 *  1. Detects running session stale > 2 hours
 *  2. Detects paused session stale > 2 hours
 *  3. Does NOT touch sessions under 2 hours
 *  4. Preserves accumulated duration in estimated_ms
 *  5. Closes open segment on stale running session
 *  6. Records stale timeout reason in note
 *  7. Returns correct count of recovered sessions
 *
 * Integrity Check Tests:
 *  8. Clean data produces no errors
 *  9. Detects multiple open segments
 * 10. Detects completed session with no duration
 */

import postgres from 'postgres';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const STALE_HOURS = 3; // 3 hours ago (beyond 2-hour threshold)
const FRESH_MINUTES = 30; // 30 minutes ago (under 2-hour threshold)

let TEST_HABIT_1;
let results = { passed: 0, failed: 0, tests: [] };

async function setAuth(conn, userId) {
  await conn.unsafe(`SET request.jwt.claim.sub = '${userId}'`);
  await conn.unsafe(`SET ROLE authenticated`);
}

async function setServiceRole() {
  await sql.unsafe(`SET ROLE service_role`);
}

async function resetRole() {
  await sql.unsafe(`RESET ROLE`);
}

async function cleanup() {
  await setServiceRole();
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.operation_failures WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.profiles WHERE id = ${TEST_USER_1}`;
  await resetRole();
}

async function setupHabit() {
  await setServiceRole();
  await sql`
    INSERT INTO public.profiles (id, display_name)
    VALUES (${TEST_USER_1}, 'Test')
    ON CONFLICT (id) DO NOTHING
  `;
  const [habit] = await sql`
    INSERT INTO public.habits (user_id, name, frequency, target_per_week, is_active)
    VALUES (${TEST_USER_1}, 'Stale Test Habit', 'daily', 3, true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit.id;
  await resetRole();
}

async function createStaleRunningSession() {
  await setServiceRole();
  const [session] = await sql`
    INSERT INTO public.habit_sessions (
      user_id, habit_id, source, status, recording_mode, started_at
    ) VALUES (
      ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'running', 'timer',
      now() - ${STALE_HOURS + '::integer'} * interval '1 hour'
    )
    RETURNING id
  `;

  // Create two segments: one completed, one running (stale)
  await sql`
    INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
    VALUES (
      ${session.id}, ${TEST_USER_1},
      now() - ${STALE_HOURS + '::integer'} * interval '1 hour',
      now() - ${(STALE_HOURS - 1) + '::integer'} * interval '1 hour'
    )
  `;
  await sql`
    INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
    VALUES (
      ${session.id}, ${TEST_USER_1},
      now() - ${(STALE_HOURS - 1) + '::integer'} * interval '1 hour',
      NULL
    )
  `;
  await resetRole();
  return session.id;
}

async function createFreshRunningSession() {
  await setServiceRole();
  const [session] = await sql`
    INSERT INTO public.habit_sessions (
      user_id, habit_id, source, status, recording_mode, started_at
    ) VALUES (
      ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'running', 'timer',
      now() - ${FRESH_MINUTES + '::integer'} * interval '1 minute'
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
    VALUES (
      ${session.id}, ${TEST_USER_1},
      now() - ${FRESH_MINUTES + '::integer'} * interval '1 minute',
      NULL
    )
  `;
  await resetRole();
  return session.id;
}

function test(name, fn) {
  return async () => {
    try {
      await fn();
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`  ✅ ${name}`);
    } catch (err) {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', error: err.message });
      console.error(`  ❌ ${name}`);
      console.error(`     ${err.message}`);
    }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ============================================================================
// TESTS
// ============================================================================

const tests = [
  test('Detects running session stale > 2 hours', async () => {
    await cleanup();
    await setupHabit();
    const sessionId = await createStaleRunningSession();

    await setAuth(sql, TEST_USER_1);
    const [result] = await sql`SELECT public.bloom_cleanup_stale_sessions() AS count`;
    assert(result.count >= 1, `Should recover at least 1 session, got ${result.count}`);

    // Verify session is now cancelled
    const [session] = await sql`
      SELECT status, estimated_ms, note FROM public.habit_sessions WHERE id = ${sessionId}
    `;
    assert(session.status === 'cancelled', 'Session should be cancelled');
  }),

  test('Detects paused session stale > 2 hours', async () => {
    await cleanup();
    await setupHabit();

    // Create a stale paused session
    await setServiceRole();
    const [session] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode, started_at
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'paused', 'timer',
        now() - 3 * interval '1 hour'
      )
      RETURNING id
    `;
    // Paused: all segments have ended_at
    await sql`
      INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
      VALUES (
        ${session.id}, ${TEST_USER_1},
        now() - 3 * interval '1 hour',
        now() - ${STALE_HOURS + '::integer'} * interval '1 hour'
      )
    `;
    await resetRole();

    await setAuth(sql, TEST_USER_1);
    const [result] = await sql`SELECT public.bloom_cleanup_stale_sessions() AS count`;
    assert(result.count >= 1, `Should recover paused session, got ${result.count}`);

    const [updated] = await sql`
      SELECT status FROM public.habit_sessions WHERE id = ${session.id}
    `;
    assert(updated.status === 'cancelled', 'Paused session should be cancelled');
  }),

  test('Does NOT touch sessions under 2 hours', async () => {
    await cleanup();
    await setupHabit();
    const sessionId = await createFreshRunningSession();

    await setAuth(sql, TEST_USER_1);
    const [result] = await sql`SELECT public.bloom_cleanup_stale_sessions() AS count`;

    const [session] = await sql`
      SELECT status FROM public.habit_sessions WHERE id = ${sessionId}
    `;
    assert(session.status === 'running', 'Fresh session should still be running');
  }),

  test('Preserves accumulated duration in estimated_ms', async () => {
    await cleanup();
    await setupHabit();
    const sessionId = await createStaleRunningSession();

    await setAuth(sql, TEST_USER_1);
    await sql`SELECT public.bloom_cleanup_stale_sessions()`;

    const [session] = await sql`
      SELECT estimated_ms, duration_ms FROM public.habit_sessions WHERE id = ${sessionId}
    `;

    assert(session.estimated_ms !== null, 'estimated_ms should be set');
    assert(session.estimated_ms > 0, 'estimated_ms should be positive (preserved progress)');
    assert(session.duration_ms === null, 'duration_ms should be null for cancelled session');
    // Should be approximately 3 hours (STALE_HOURS) in ms
    const expectedMs = STALE_HOURS * 60 * 60 * 1000;
    const tolerance = 60000; // 1 minute tolerance
    assert(
      Math.abs(session.estimated_ms - expectedMs) < tolerance,
      `estimated_ms should be ~${expectedMs}ms, got ${session.estimated_ms}`
    );
  }),

  test('Closes open segment on stale running session', async () => {
    await cleanup();
    await setupHabit();
    const sessionId = await createStaleRunningSession();

    await setAuth(sql, TEST_USER_1);
    await sql`SELECT public.bloom_cleanup_stale_sessions()`;

    const openSegments = await sql`
      SELECT COUNT(*)::int AS count FROM public.habit_session_segments
      WHERE session_id = ${sessionId} AND ended_at IS NULL
    `;
    assert(openSegments[0].count === 0, 'All segments should be closed');

    const allSegments = await sql`
      SELECT COUNT(*)::int AS count FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
    `;
    assert(allSegments[0].count === 2, 'Should still have 2 segments');
  }),

  test('Records stale timeout reason in note', async () => {
    await cleanup();
    await setupHabit();
    const sessionId = await createStaleRunningSession();

    await setAuth(sql, TEST_USER_1);
    await sql`SELECT public.bloom_cleanup_stale_sessions()`;

    const [session] = await sql`
      SELECT note FROM public.habit_sessions WHERE id = ${sessionId}
    `;
    assert(
      session.note && session.note.includes('stale'),
      `Note should mention stale recovery, got: ${session.note}`
    );
  }),

  test('Returns correct count of recovered sessions', async () => {
    await cleanup();
    await setupHabit();

    // Create 2 stale sessions
    await createStaleRunningSession();
    await createStaleRunningSession();

    await setAuth(sql, TEST_USER_1);
    const [result] = await sql`SELECT public.bloom_cleanup_stale_sessions() AS count`;
    assert(result.count === 2, `Should recover 2 sessions, got ${result.count}`);
  }),

  test('SECURITY: User A cannot trigger recovery of User B sessions', async () => {
    await cleanup();
    await setupHabit();

    const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';

    // Create a stale session for User 2
    await setServiceRole();
    await sql`
      INSERT INTO public.profiles (id, display_name)
      VALUES (${TEST_USER_2}, 'User B')
      ON CONFLICT (id) DO NOTHING
    `;
    const [habit2] = await sql`
      INSERT INTO public.habits (user_id, name, frequency, target_per_week, is_active)
      VALUES (${TEST_USER_2}, 'User B Habit', 'daily', 3, true)
      RETURNING id
    `;
    const [session2] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode, started_at
      ) VALUES (
        ${TEST_USER_2}, ${habit2.id}, 'timed', 'running', 'timer',
        now() - 3 * interval '1 hour'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
      VALUES (${session2.id}, ${TEST_USER_2}, now() - 3 * interval '1 hour', NULL)
    `;
    await resetRole();

    // Also create a stale session for User 1
    const session1 = await createStaleRunningSession();

    // User 1 calls cleanup — should ONLY affect User 1's session
    await setAuth(sql, TEST_USER_1);
    const [result] = await sql`SELECT public.bloom_cleanup_stale_sessions() AS count`;

    // User 1's session should be cancelled
    const [s1] = await sql`SELECT status FROM public.habit_sessions WHERE id = ${session1}`;
    assert(s1.status === 'cancelled', 'User 1 stale session should be cancelled');

    // User 2's session should STILL be running (not touched by User 1)
    await setServiceRole();
    const [s2] = await sql`SELECT status FROM public.habit_sessions WHERE id = ${session2.id}`;
    assert(s2.status === 'running',
      `User 2 session must remain running, but got: ${s2.status}`);

    // Cleanup user 2 data
    await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_2}`;
    await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_2}`;
    await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_2}`;
    await sql`DELETE FROM public.profiles WHERE id = ${TEST_USER_2}`;
    await resetRole();
  }),

  // ========================================================================
  // INTEGRITY CHECK TESTS
  // ========================================================================

  test('Clean data produces no errors', async () => {
    await cleanup();
    await setupHabit();

    // Create a clean completed session
    await setServiceRole();
    const [session] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        started_at, completed_at, completed_on, duration_ms
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'completed', 'timer',
        now() - interval '1 hour', now() - interval '30 minutes',
        (now() AT TIME ZONE 'Africa/Lagos')::date, 1800000
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
      VALUES (${session.id}, ${TEST_USER_1}, now() - interval '1 hour', now() - interval '30 minutes')
    `;
    await resetRole();

    await setAuth(sql, TEST_USER_1);
    const issues = await sql`SELECT * FROM public.bloom_check_data_integrity()`;

    const errors = issues.filter(i => i.severity === 'error');
    assert(errors.length === 0, `Clean data should have no errors, got: ${JSON.stringify(errors)}`);
  }),

  test('Detects multiple open segments', async () => {
    await cleanup();
    await setupHabit();
    const sessionId = await createFreshRunningSession();

    // Add a second open segment (invalid state)
    await setServiceRole();
    await sql`
      INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
      VALUES (${sessionId}, ${TEST_USER_1}, now() - interval '10 minutes', NULL)
    `;
    await resetRole();

    await setAuth(sql, TEST_USER_1);
    const issues = await sql`SELECT * FROM public.bloom_check_data_integrity()`;

    const multipleOpen = issues.filter(i => i.issue_type === 'multiple_open_segments');
    assert(multipleOpen.length >= 1, 'Should detect multiple open segments');
    assert(multipleOpen[0].severity === 'error', 'Multiple open segments should be an error');
  }),

  test('Detects completed session with no duration', async () => {
    await cleanup();
    await setupHabit();

    // Create a completed session with no duration
    await setServiceRole();
    await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        started_at, completed_at, completed_on
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'completed', 'timer',
        now() - interval '1 hour', now() - interval '30 minutes',
        (now() AT TIME ZONE 'Africa/Lagos')::date
      )
    `;
    await resetRole();

    await setAuth(sql, TEST_USER_1);
    const issues = await sql`SELECT * FROM public.bloom_check_data_integrity()`;

    const noDuration = issues.filter(i => i.issue_type === 'completed_no_duration');
    assert(noDuration.length >= 1, 'Should detect completed session without duration');
  }),
];

// ============================================================================
// RUNNER
// ============================================================================

async function run() {
  console.log('\n📋 Phase 5: Stale Session Recovery & Data Integrity Tests\n');

  for (const t of tests) {
    await t();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${results.passed} passed, ${results.failed} failed, ${results.passed + results.failed} total`);

  await sql.end();

  if (results.failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  sql.end();
  process.exit(1);
});
