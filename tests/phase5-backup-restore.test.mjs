#!/usr/bin/env node
/**
 * Phase 5: Backup & Restore Tests
 *
 * Tests:
 *  1. Snapshot captures all user data from 9 tables
 *  2. Snapshot records correct reason and timestamp
 *  3. Snapshot reason is required
 *  4. Snapshot only captures own data (RLS)
 *  5. Authenticated user cannot call restore (EXECUTE revoked)
 *  6. Service-role can restore with explicit target_user_id
 *  7. Cross-user snapshot restore blocked (snapshot belongs to different user)
 *  8. p_force unavailable to authenticated users (can't call at all)
 *  9. Restore errors when newer data exists without p_force
 * 10. Restore with p_force overwrites existing data
 * 11. Restore is idempotent (double restore = same result)
 * 12. Snapshot preserves habit-log FK relationships
 * 13. Snapshot captures habit versions
 */

import postgres from 'postgres';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';

let TEST_HABIT_1;
let results = { passed: 0, failed: 0, tests: [] };

async function setAuth(userId) {
  await sql.unsafe(`SET request.jwt.claim.sub = '${userId}'`);
  await sql.unsafe(`SET ROLE authenticated`);
}

async function setServiceRole() {
  await sql.unsafe(`RESET ROLE`);
  await sql.unsafe(`SET ROLE service_role`);
}

async function resetRole() {
  await sql.unsafe(`RESET ROLE`);
}

async function cleanup() {
  await setServiceRole();
  await sql`DELETE FROM public.user_data_snapshots WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.user_data_snapshots WHERE user_id = ${TEST_USER_2}`;
  await sql`DELETE FROM public.habit_session_segments WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.habit_versions WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.session_command_requests WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.habit_logs WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.habits WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await sql`DELETE FROM public.profiles WHERE id IN (${TEST_USER_1}, ${TEST_USER_2})`;
  await resetRole();
}

async function setupTestData() {
  await cleanup();
  await setServiceRole();

  await sql`
    INSERT INTO public.profiles (id, display_name)
    VALUES (${TEST_USER_1}, 'Phase 5 Test User')
    ON CONFLICT (id) DO NOTHING
  `;

  const [habit] = await sql`
    INSERT INTO public.habits (user_id, name, frequency, target_per_week, is_active)
    VALUES (${TEST_USER_1}, 'Backup Test Habit', 'daily', 5, true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit.id;

  await sql`
    INSERT INTO public.habit_logs (habit_id, user_id, completed_on, note)
    VALUES (${TEST_HABIT_1}, ${TEST_USER_1}, ${new Date().toISOString().slice(0, 10)}, 'Test log for backup')
    ON CONFLICT (habit_id, completed_on) DO NOTHING
  `;

  await resetRole();
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
    await setAuth(TEST_USER_1);

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
    await setAuth(TEST_USER_1);

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
    await setAuth(TEST_USER_1);

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
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: ownership') AS id
    `;

    await setAuth(TEST_USER_2);
    const visible = await sql`
      SELECT COUNT(*)::int AS count FROM public.user_data_snapshots
      WHERE id = ${result.id}
    `;
    assert(visible[0].count === 0, 'User 2 should not see User 1 snapshot');
  }),

  test('Authenticated user cannot call restore (EXECUTE revoked)', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: auth check') AS id
    `;

    let errored = false;
    try {
      await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, false)`;
    } catch (e) {
      errored = true;
      assert(
        e.message.includes('permission denied') || e.message.includes('not permitted')
        || e.message.includes('EXECUTE') || e.message.includes('not allowed'),
        `Should be permission error, got: ${e.message}`
      );
    }
    assert(errored, 'Authenticated user should not call restore');
  }),

  test('Service-role can restore with explicit target_user_id', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: service-role restore') AS id
    `;

    // Delete user data
    await setServiceRole();
    await sql`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_1}`;
    await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;

    // Restore via service_role with explicit target_user_id
    await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, false)`;

    const habits = await sql`
      SELECT COUNT(*)::int AS count FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;
    assert(habits[0].count >= 1, 'Habits should be restored by service_role');
    await resetRole();
  }),

  test('Cross-user snapshot restore blocked (wrong target_user_id)', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: cross-user') AS id
    `;

    // Service-role tries to restore User 1's snapshot but passes User 2 as target
    await setServiceRole();
    let errored = false;
    try {
      await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_2}, true)`;
    } catch (e) {
      errored = true;
      assert(
        e.message.includes('belongs to') || e.message.includes('Access denied'),
        `Error should mention ownership mismatch, got: ${e.message}`
      );
    }
    assert(errored, 'Should reject when snapshot user_id != target_user_id');
    await resetRole();
  }),

  test('p_force unavailable to authenticated users (cannot call at all)', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: force check') AS id
    `;

    let errored = false;
    try {
      await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, true)`;
    } catch (e) {
      errored = true;
    }
    assert(errored, 'Authenticated user should not call restore at all (even with p_force)');
  }),

  test('Restore errors when newer data exists without p_force', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: force check') AS id
    `;

    // Service-role: restore without force should error when data exists
    await setServiceRole();
    let errored = false;
    try {
      await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, false)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('existing habits') || e.message.includes('p_force'),
        'Error should mention existing data');
    }
    assert(errored, 'Should error without p_force when data exists');
    await resetRole();
  }),

  test('Restore with p_force overwrites existing data', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: force restore') AS id
    `;

    // Add more data after snapshot
    await setServiceRole();
    await sql`
      INSERT INTO public.habits (user_id, name, is_active)
      VALUES (${TEST_USER_1}, 'Post-snapshot habit', true)
    `;

    // Force restore via service_role
    await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, true)`;

    const habits = await sql`
      SELECT name FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;
    const names = habits.map(h => h.name);
    assert(names.includes('Backup Test Habit'), 'Original habit should be restored');
    assert(!names.includes('Post-snapshot habit'), 'Post-snapshot habit should be removed');
    await resetRole();
  }),

  test('Restore is idempotent (double restore = same result)', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: idempotent') AS id
    `;

    await setServiceRole();
    await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, true)`;

    const afterFirst = await sql`
      SELECT COUNT(*)::int AS habits, 
             (SELECT COUNT(*)::int FROM public.habit_logs WHERE user_id = ${TEST_USER_1}) AS logs
      FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;

    await sql`SELECT public.bloom_restore_user_data(${result.id}, ${TEST_USER_1}, true)`;

    const afterSecond = await sql`
      SELECT COUNT(*)::int AS habits,
             (SELECT COUNT(*)::int FROM public.habit_logs WHERE user_id = ${TEST_USER_1}) AS logs
      FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;

    assert(afterFirst[0].habits === afterSecond[0].habits, 'Same habit count after double restore');
    assert(afterFirst[0].logs === afterSecond[0].logs, 'Same log count after double restore');
    await resetRole();
  }),

  test('Snapshot preserves habit-log FK relationships', async () => {
    await setupTestData();
    await setAuth(TEST_USER_1);

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
    await resetRole();

    await setAuth(TEST_USER_1);
    const [result] = await sql`
      SELECT public.bloom_snapshot_user_data('test: versions') AS id
    `;

    const [snapshot] = await sql`
      SELECT snapshot_data FROM public.user_data_snapshots WHERE id = ${result.id}
    `;

    assert(snapshot.snapshot_data.habit_versions.length >= 1,
      'Should capture habit versions');
  }),

  test('IDENTITY SEQUENCES: All 5 tables — normal insert after restore', async () => {
    await setupTestData();
    await setServiceRole();

    // Create a completed quick session (needed for segments)
    const [session] = await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        started_at, completed_at, completed_on, duration_ms
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'quick', 'completed', 'quick',
        now() - interval '2 hours', now() - interval '1 hour',
        (now() AT TIME ZONE 'Africa/Lagos')::date, 3600000
      ) RETURNING id
    `;

    // 1. habit_session_segments (identity)
    await sql`
      INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
      VALUES (${session.id}, ${TEST_USER_1}, now() - interval '2 hours', now() - interval '1 hour')
    `;

    // 2. habit_session_goal_versions (identity)
    const [weekRow] = await sql`SELECT public.lagos_week_start((now() AT TIME ZONE 'Africa/Lagos')::date) AS d`;
    await sql`
      INSERT INTO public.habit_session_goal_versions (
        habit_id, user_id, effective_week, weekly_session_target, goal_confirmed
      ) VALUES (${TEST_HABIT_1}, ${TEST_USER_1}, ${weekRow.d}, 3, true)
    `;

    // 3. session_command_requests (identity)
    await sql`
      INSERT INTO public.session_command_requests (
        request_id, user_id, operation_type, operation_payload
      ) VALUES ('seq-test-req-1', ${TEST_USER_1}, 'start_session', '{"test": true}'::jsonb)
    `;

    // 4. incomplete_deletions (identity)
    await sql`
      INSERT INTO public.incomplete_deletions (
        user_id, user_email, database_deleted_at, auth_deletion_attempts
      ) VALUES (${TEST_USER_1}, 'user1@test.com', now(), 1)
    `;

    // 5. habit_versions (identity — already created by trigger, but add one explicitly)
    await sql`
      INSERT INTO public.habit_versions (
        habit_id, user_id, is_baseline, name, frequency, target_per_week,
        color, icon, is_active
      ) VALUES (
        ${TEST_HABIT_1}, ${TEST_USER_1}, false, 'Seq Test Version', 'daily', 5,
        '#00ff00', 'check', true
      )
    `;

    await resetRole();

    // Take snapshot
    await setAuth(TEST_USER_1);
    const [snapResult] = await sql`
      SELECT public.bloom_snapshot_user_data('test: all 5 sequences') AS id
    `;

    // Restore (deletes + re-inserts with OVERRIDING SYSTEM VALUE + sequence sync)
    await setServiceRole();
    await sql`SELECT public.bloom_restore_user_data(${snapResult.id}, ${TEST_USER_1}, true)`;

    // Capture max restored IDs for all 5 tables
    const [maxSeg] = await sql`SELECT COALESCE(MAX(id), 0)::int AS max_id FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
    const [maxGV] = await sql`SELECT COALESCE(MAX(id), 0)::int AS max_id FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
    const [maxSCR] = await sql`SELECT COALESCE(MAX(id), 0)::int AS max_id FROM public.session_command_requests WHERE user_id = ${TEST_USER_1}`;
    const [maxIDel] = await sql`SELECT COALESCE(MAX(id), 0)::int AS max_id FROM public.incomplete_deletions WHERE user_id = ${TEST_USER_1}`;
    const [maxHV] = await sql`SELECT COALESCE(MAX(id), 0)::int AS max_id FROM public.habit_versions WHERE user_id = ${TEST_USER_1}`;

    console.log(`     Max restored IDs: segments=${maxSeg.max_id}, goals=${maxGV.max_id}, cmds=${maxSCR.max_id}, deletions=${maxIDel.max_id}, versions=${maxHV.max_id}`);

    // Now perform normal inserts into ALL 5 identity-backed tables
    // Each new ID must be strictly greater than the max restored ID

    // Get the restored session ID for segment insert
    const [restoredSession] = await sql`
      SELECT id FROM public.habit_sessions WHERE user_id = ${TEST_USER_1} LIMIT 1
    `;

    // 1. habit_session_segments
    const [newSeg] = await sql`
      INSERT INTO public.habit_session_segments (session_id, user_id, started_at, ended_at)
      VALUES (${restoredSession.id}, ${TEST_USER_1}, now(), now())
      RETURNING id
    `;
    assert(newSeg.id > maxSeg.max_id, `1. segments: new id=${newSeg.id} must be > max restored=${maxSeg.max_id}`);
    const [verifySeg] = await sql`SELECT id FROM public.habit_session_segments WHERE id = ${newSeg.id}`;
    assert(verifySeg.id === newSeg.id, '1. segments: record exists');

    // 2. habit_session_goal_versions
    const [nextWeek] = await sql`SELECT public.lagos_week_start((now() AT TIME ZONE 'Africa/Lagos')::date + 7) AS d`;
    const [newGV] = await sql`
      INSERT INTO public.habit_session_goal_versions (
        habit_id, user_id, effective_week, weekly_session_target, goal_confirmed
      ) VALUES (${TEST_HABIT_1}, ${TEST_USER_1}, ${nextWeek.d}, 5, true)
      RETURNING id
    `;
    assert(newGV.id > maxGV.max_id, `2. goal_versions: new id=${newGV.id} must be > max restored=${maxGV.max_id}`);
    const [verifyGV] = await sql`SELECT id FROM public.habit_session_goal_versions WHERE id = ${newGV.id}`;
    assert(verifyGV.id === newGV.id, '2. goal_versions: record exists');

    // 3. session_command_requests
    const [newSCR] = await sql`
      INSERT INTO public.session_command_requests (
        request_id, user_id, operation_type, operation_payload
      ) VALUES ('seq-post-restore-1', ${TEST_USER_1}, 'quick_log', '{}'::jsonb)
      RETURNING id
    `;
    assert(newSCR.id > maxSCR.max_id, `3. command_requests: new id=${newSCR.id} must be > max restored=${maxSCR.max_id}`);
    const [verifySCR] = await sql`SELECT id FROM public.session_command_requests WHERE id = ${newSCR.id}`;
    assert(verifySCR.id === newSCR.id, '3. command_requests: record exists');

    // 4. incomplete_deletions
    const [newIDel] = await sql`
      INSERT INTO public.incomplete_deletions (
        user_id, user_email, database_deleted_at, auth_deletion_attempts
      ) VALUES (${TEST_USER_1}, 'post-restore@test.com', now(), 1)
      RETURNING id
    `;
    assert(newIDel.id > maxIDel.max_id, `4. incomplete_deletions: new id=${newIDel.id} must be > max restored=${maxIDel.max_id}`);
    const [verifyIDel] = await sql`SELECT id FROM public.incomplete_deletions WHERE id = ${newIDel.id}`;
    assert(verifyIDel.id === newIDel.id, '4. incomplete_deletions: record exists');

    // 5. habit_versions
    const [newHV] = await sql`
      INSERT INTO public.habit_versions (
        habit_id, user_id, is_baseline, name, frequency, target_per_week,
        color, icon, is_active
      ) VALUES (
        ${TEST_HABIT_1}, ${TEST_USER_1}, false, 'Post-Restore Version', 'daily', 7,
        '#0000ff', 'star', true
      )
      RETURNING id
    `;
    assert(newHV.id > maxHV.max_id, `5. habit_versions: new id=${newHV.id} must be > max restored=${maxHV.max_id}`);
    const [verifyHV] = await sql`SELECT id FROM public.habit_versions WHERE id = ${newHV.id}`;
    assert(verifyHV.id === newHV.id, '5. habit_versions: record exists');

    console.log(`     Post-restore IDs: segments=${newSeg.id}, goals=${newGV.id}, cmds=${newSCR.id}, deletions=${newIDel.id}, versions=${newHV.id}`);
    console.log(`     All 5 sequences verified: new IDs strictly greater than max restored IDs`);
    await resetRole();
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
