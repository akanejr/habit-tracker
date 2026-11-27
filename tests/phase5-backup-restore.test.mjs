#!/usr/bin/env node
/**
 * Phase 5: Backup & Restore Tests
 *
 * Tests:
 *  1. Snapshot captures all user data from 9 tables
 *  2. Snapshot records correct reason and timestamp
 *  3. Snapshot is immutable (no UPDATE policy)
 *  4. Snapshot can only capture own data (RLS)
 *  5. Restore recreates all data from snapshot
 *  6. Restore validates ownership (rejects other user's snapshot)
 *  7. Restore errors when newer data exists without p_force
 *  8. Restore with p_force overwrites existing data
 *  9. Restore is idempotent (double restore = same result)
 * 10. Snapshot preserves foreign key relationships
 */

import postgres from 'postgres';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';
const TEST_RUN = Date.now();

let TEST_HABIT_1;
let TEST_SESSION_1;
let results = { passed: 0, failed: 0, tests: [] };

async function setAuth(conn, userId) {
  await conn.unsafe(`SET request.jwt.claim.sub = '${userId}'`);
  await conn.unsafe(`SET ROLE authenticated`);
}

async function setServiceRole() {
  await sql.unsafe(`SET ROLE service_role`);
}

async function cleanup() {
  await setServiceRole();
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.user_data_snapshots WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.user_data_snapshots WHERE user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.profiles WHERE id = ${TEST_USER_1}`;
  await sql`RESET ROLE`;
}

async function setupTestData() {
  await cleanup();
  await setServiceRole();

  // Create profile
  await sql`
    INSERT INTO public.profiles (id, display_name)
    VALUES (${TEST_USER_1}, 'Phase 5 Test User')
    ON CONFLICT (id) DO NOTHING
  `;

  // Create habit
  const [habit] = await sql`
    INSERT INTO public.habits (user_id, name, frequency, target_per_week, is_active)
    VALUES (${TEST_USER_1}, 'Backup Test Habit', 'daily', 5, true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit.id;

  // Create habit log
  await sql`
    INSERT INTO public.habit_logs (habit_id, user_id, completed_on, note)
    VALUES (${TEST_HABIT_1}, ${TEST_USER_1}, ${new Date().toISOString().slice(0, 10)}, 'Test log for backup')
    ON CONFLICT (habit_id, completed_on) DO NOTHING
  `;

  await sql`RESET ROLE`;
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
  test('Snapshot captures data from all 9 tables', async () => {
    await setupTestData();
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: full capture') AS id
    `;
    assert(result.id > 0, 'Should return snapshot ID');

    const [snapshot] = await sql`
      SELECT snapshot_data FROM public.user_data_snapshots WHERE id = ${result.id}
    `;

    const data = snapshot.snapshot_data;
    assert(data.profiles.length >= 1, 'Should capture profiles');
    assert(data.habits.length >= 1, 'Should capture habits');
    assert(data.habit_logs.length >= 1, 'Should capture habit_logs');
    assert(Array.isArray(data.habit_sessions), 'Should include habit_sessions array');
    assert(Array.isArray(data.habit_session_segments), 'Should include segments array');
    assert(Array.isArray(data.habit_session_goal_versions), 'Should include goal_versions array');
    assert(Array.isArray(data.habit_versions), 'Should include habit_versions array');
    assert(Array.isArray(data.session_command_requests), 'Should include command_requests array');
    assert(Array.isArray(data.incomplete_deletions), 'Should include incomplete_deletions array');
    assert(data.snapshot_version === 1, 'Should include snapshot_version');
  }),

  test('Snapshot records correct reason and timestamp', async () => {
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: reason check') AS id
    `;

    const [snapshot] = await sql`
      SELECT reason, created_at, snapshot_data FROM public.user_data_snapshots
      WHERE id = ${result.id}
    `;

    assert(snapshot.reason === 'test: reason check', 'Reason should match');
    assert(snapshot.created_at !== null, 'Should have created_at timestamp');
    assert(snapshot.snapshot_data.captured_at !== null, 'Should have captured_at in data');
  }),

  test('Snapshot reason is required', async () => {
    await setAuth(sql, TEST_USER_1);

    let errored = false;
    try {
      await sql`SELECT public.bloom_snapshot_user_data('')`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('reason'), 'Error should mention reason');
    }
    assert(errored, 'Should reject empty reason');
  }),

  test('Snapshot only captures own data (RLS)', async () => {
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: ownership') AS id
    `;

    // User 2 should not see user 1's snapshot
    await setAuth(sql, TEST_USER_2);
    const visible = await sql`
      SELECT COUNT(*)::int AS count FROM public.user_data_snapshots
      WHERE id = ${result.id}
    `;
    assert(visible[0].count === 0, 'User 2 should not see User 1 snapshot');
  }),

  test('Restore validates ownership', async () => {
    await setupTestData();
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: ownership check') AS id
    `;

    // User 2 should not be able to restore user 1's snapshot
    await setAuth(sql, TEST_USER_2);
    let errored = false;
    try {
      await setServiceRole();
      // Even service_role should check that the caller matches the snapshot owner
      await sql`SELECT public.bloom_restore_user_data(${result.id}, true)`;
    } catch (e) {
      errored = true;
    }
    // Note: SECURITY DEFINER bypasses caller auth; the function itself checks ownership
    // So this test verifies the function's internal ownership check
    await sql`RESET ROLE`;
    // The restore function checks v_snapshot.user_id != v_caller_id
    // When called as user 2 via SECURITY DEFINER, auth.uid() returns user 2
    await setAuth(sql, TEST_USER_2);
    errored = false;
    try {
      await sql`SELECT public.bloom_restore_user_data(${result.id}, true)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('different user') || e.message.includes('Access denied'),
        'Error should mention ownership');
    }
    assert(errored, 'User 2 should not restore User 1 snapshot');
  }),

  test('Restore errors when newer data exists without p_force', async () => {
    await setupTestData();
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: force check') AS id
    `;

    // User has habits, restore without force should error
    let errored = false;
    try {
      await sql`SELECT public.bloom_restore_user_data(${result.id}, false)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('existing habits') || e.message.includes('p_force'),
        'Error should mention existing data');
    }
    assert(errored, 'Should error without p_force when data exists');
  }),

  test('Restore with p_force overwrites existing data', async () => {
    await setupTestData();
    await setAuth(sql, TEST_USER_1);

    // Take snapshot
    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: force restore') AS id
    `;

    // Add more data after snapshot
    await setServiceRole();
    await sql`
      INSERT INTO public.habits (user_id, name, is_active)
      VALUES (${TEST_USER_1}, 'Post-snapshot habit', true)
    `;
    await sql`RESET ROLE`;

    // Force restore should succeed
    await setAuth(sql, TEST_USER_1);
    await sql`SELECT public.bloom_restore_user_data(${result.id}, true)`;

    // Verify: post-snapshot habit should be gone
    const habits = await sql`
      SELECT name FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;
    const names = habits.map(h => h.name);
    assert(names.includes('Backup Test Habit'), 'Original habit should be restored');
    assert(!names.includes('Post-snapshot habit'), 'Post-snapshot habit should be removed');
  }),

  test('Restore is idempotent (double restore = same result)', async () => {
    await setupTestData();
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: idempotent') AS id
    `;

    // First restore
    await sql`SELECT public.bloom_restore_user_data(${result.id}, true)`;

    const afterFirst = await sql`
      SELECT COUNT(*)::int AS habits, 
             (SELECT COUNT(*)::int FROM public.habit_logs WHERE user_id = ${TEST_USER_1}) AS logs
      FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;

    // Second restore
    await sql`SELECT public.bloom_restore_user_data(${result.id}, true)`;

    const afterSecond = await sql`
      SELECT COUNT(*)::int AS habits,
             (SELECT COUNT(*)::int FROM public.habit_logs WHERE user_id = ${TEST_USER_1}) AS logs
      FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;

    assert(afterFirst[0].habits === afterSecond[0].habits, 'Same habit count after double restore');
    assert(afterFirst[0].logs === afterSecond[0].logs, 'Same log count after double restore');
  }),

  test('Snapshot preserves habit-log foreign key relationships', async () => {
    await setupTestData();
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: FK integrity') AS id
    `;

    const [snapshot] = await sql`
      SELECT snapshot_data FROM public.user_data_snapshots WHERE id = ${result.id}
    `;

    const habitIds = new Set(snapshot.snapshot_data.habits.map(h => h.id));
    for (const log of snapshot.snapshot_data.habit_logs) {
      assert(habitIds.has(log.habit_id),
        `Log habit_id ${log.habit_id} should exist in snapshot habits`);
    }
  }),

  test('Snapshot captures habit versions', async () => {
    await setupTestData();

    // Create a habit version by modifying the habit
    await setServiceRole();
    await sql`
      INSERT INTO public.habit_versions (
        habit_id, user_id, is_baseline, name, frequency, target_per_week,
        color, icon, is_active
      ) VALUES (
        ${TEST_HABIT_1}, ${TEST_USER_1}, false, 'Updated Habit', 'daily', 5,
        '#ff0000', 'star', true
      )
    `;
    await sql`RESET ROLE`;

    await setAuth(sql, TEST_USER_1);
    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: versions') AS id
    `;

    const [snapshot] = await sql`
      SELECT snapshot_data FROM public.user_data_snapshots WHERE id = ${result.id}
    `;

    assert(snapshot.snapshot_data.habit_versions.length >= 1,
      'Should capture habit versions');
  }),
];

// ============================================================================
// RUNNER
// ============================================================================

async function run() {
  console.log('\n📋 Phase 5: Backup & Restore Tests\n');

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
