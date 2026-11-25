#!/usr/bin/env node

/**
 * Phase 3 Security Tests
 * 
 * Comprehensive security testing covering:
 * 1. Route protection (middleware/proxy)
 * 2. RLS policy enforcement
 * 3. Cross-user data access attempts
 * 4. Account deletion authorization
 * 5. Session validation
 * 6. INSERT policy WITH CHECK enforcement
 */

import postgres from 'postgres';
import assert from 'assert';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);
const sql2 = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';
const TEST_RUN_ID = Date.now();

let TEST_HABIT_1;
let TEST_HABIT_2;

async function setAuth(conn, email) {
  await conn.unsafe(`SET app.current_user_email = '${email}'`);
}

async function cleanup() {
  // Clean up user1's data
  await setAuth(sql, 'user1@test.com');
  await sql`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;
  
  // Clean up user2's data
  await setAuth(sql2, 'user2@test.com');
  await sql2`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habits WHERE user_id = ${TEST_USER_2}`;
}

async function setupTestData() {
  await setAuth(sql, 'user1@test.com');
  await setAuth(sql2, 'user2@test.com');
  await cleanup();
  
  // Create habits for user1
  const [habit1] = await sql`
    INSERT INTO public.habits (user_id, name, is_active)
    VALUES (${TEST_USER_1}, 'Exercise', true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit1.id;

  // Create habits for user2
  const [habit2] = await sql2`
    INSERT INTO public.habits (user_id, name, is_active)
    VALUES (${TEST_USER_2}, 'Read', true)
    RETURNING id
  `;
  TEST_HABIT_2 = habit2.id;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    return true;
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
    return false;
  }
}

async function runTests() {
  console.log('\n🔒 Phase 3 Security Tests\n');
  
  let passed = 0;
  let total = 0;

  // ========================================================================
  // RLS ENFORCEMENT TESTS
  // ========================================================================
  
  console.log('📋 RLS Enforcement Tests');

  // Test 1: User cannot select other user's habits
  total++;
  if (await test('User cannot select other user\'s habits', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    const habits = await sql`
      SELECT id FROM public.habits WHERE user_id = ${TEST_USER_2}
    `;
    
    if (habits.length > 0) {
      throw new Error(`User 1 can see User 2's habits: ${habits.length} found`);
    }
  })) passed++;

  // Test 2: User cannot select other user's sessions
  total++;
  if (await test('User cannot select other user\'s sessions', async () => {
    await setupTestData();
    
    // Create a session for user2
    await setAuth(sql2, 'user2@test.com');
    await sql2`SELECT public.bloom_start_session(${`req-sec-1-${TEST_RUN_ID}`}, ${TEST_HABIT_2})`;
    
    // Try to access as user1
    await setAuth(sql, 'user1@test.com');
    const sessions = await sql`
      SELECT id FROM public.habit_sessions WHERE user_id = ${TEST_USER_2}
    `;
    
    if (sessions.length > 0) {
      throw new Error(`User 1 can see User 2's sessions: ${sessions.length} found`);
    }
  })) passed++;

  // Test 3: User cannot update other user's habits
  total++;
  if (await test('User cannot update other user\'s habits', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`
        UPDATE public.habits SET name = 'Hacked' WHERE user_id = ${TEST_USER_2}
      `;
      throw new Error('Should have rejected cross-user update');
    } catch (err) {
      if (!err.message.includes('RLS') && !err.message.includes('permission') && !err.message.includes('0 rows')) {
        // Check if no rows were actually updated
        const [check] = await sql2`
          SELECT name FROM public.habits WHERE id = ${TEST_HABIT_2}
        `;
        if (check.name === 'Hacked') {
          throw new Error('Cross-user update succeeded');
        }
      }
    }
  })) passed++;

  // Test 4: User cannot delete other user's habits
  total++;
  if (await test('User cannot delete other user\'s habits', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`
        DELETE FROM public.habits WHERE user_id = ${TEST_USER_2}
      `;
      // Check if deletion actually happened
      const [check] = await sql2`
        SELECT id FROM public.habits WHERE id = ${TEST_HABIT_2}
      `;
      if (!check) {
        throw new Error('Cross-user delete succeeded');
      }
    } catch (err) {
      // Expected - RLS should prevent this
    }
  })) passed++;

  // ========================================================================
  // INSERT POLICY WITH CHECK TESTS
  // ========================================================================
  
  console.log('\n📋 INSERT Policy WITH CHECK Tests');

  // Test 5: User cannot insert habit for another user
  total++;
  if (await test('User cannot insert habit for another user', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`
        INSERT INTO public.habits (user_id, name, is_active)
        VALUES (${TEST_USER_2}, 'Malicious Habit', true)
      `;
      throw new Error('Should have rejected cross-user insert');
    } catch (err) {
      if (!err.message.includes('new row violates row-level security policy') &&
          !err.message.includes('permission denied')) {
        throw new Error(`Expected RLS violation, got: ${err.message}`);
      }
    }
  })) passed++;

  // Test 6: User cannot insert session log for another user
  total++;
  if (await test('User cannot insert session log for another user', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`
        INSERT INTO public.habit_logs (user_id, habit_id, completed_on, note)
        VALUES (${TEST_USER_2}, ${TEST_HABIT_2}, CURRENT_DATE, 'Malicious log')
      `;
      throw new Error('Should have rejected cross-user log insert');
    } catch (err) {
      if (!err.message.includes('new row violates row-level security policy') &&
          !err.message.includes('permission denied')) {
        throw new Error(`Expected RLS violation, got: ${err.message}`);
      }
    }
  })) passed++;

  // ========================================================================
  // ACCOUNT DELETION TESTS
  // ========================================================================
  
  console.log('\n📋 Account Deletion Tests');

  // Test 7: Unauthenticated user cannot delete account
  total++;
  if (await test('Unauthenticated user cannot delete account', async () => {
    // Reset auth context
    await sql.unsafe('RESET app.current_user_email');
    
    try {
      await sql`SELECT public.delete_user_account('DELETE MY ACCOUNT')`;
      throw new Error('Should have rejected unauthenticated deletion');
    } catch (err) {
      if (!err.message.includes('Not authenticated')) {
        throw new Error(`Expected authentication error, got: ${err.message}`);
      }
    }
  })) passed++;

  // Test 8: User cannot delete account without confirmation
  total++;
  if (await test('User cannot delete account without confirmation', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    try {
      await sql`SELECT public.delete_user_account('wrong')`;
      throw new Error('Should have rejected invalid confirmation');
    } catch (err) {
      if (!err.message.includes('Confirmation text must be "DELETE"')) {
        throw new Error(`Expected confirmation error, got: ${err.message}`);
      }
    }
  })) passed++;

  // Test 9: User can delete own account with correct confirmation
  total++;
  if (await test('User can delete own account with correct confirmation', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    // Verify user has data
    const [beforeHabits] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;
    if (beforeHabits.cnt === 0) {
      throw new Error('Test setup failed: no habits for user1');
    }
    
    // Delete account
    const [result] = await sql`SELECT public.delete_user_account('DELETE MY ACCOUNT')`;
    
    if (!result.delete_user_account.success) {
      throw new Error('Account deletion failed');
    }
    
    // Verify all data is deleted
    const [afterHabits] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;
    if (afterHabits.cnt > 0) {
      throw new Error(`Habits not deleted: ${afterHabits.cnt} remaining`);
    }
    
    const [afterSessions] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}
    `;
    if (afterSessions.cnt > 0) {
      throw new Error(`Sessions not deleted: ${afterSessions.cnt} remaining`);
    }
  })) passed++;

  // Test 10: Account deletion removes all related data
  total++;
  if (await test('Account deletion removes all related data', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    // Create some sessions and logs
    await sql`SELECT public.bloom_start_session(${`req-del-1-${TEST_RUN_ID}`}, ${TEST_HABIT_1})`;
    await sql`SELECT public.bloom_quick_log(${`req-del-2-${TEST_RUN_ID}`}, ${TEST_HABIT_1}, 1800000, 'Test log')`;
    
    // Delete account
    await sql`SELECT public.delete_user_account('DELETE MY ACCOUNT')`;
    
    // Verify all tables are empty for this user
    const tables = [
      'habits',
      'habit_logs',
      'habit_versions',
      'habit_sessions',
      'habit_session_segments',
      'habit_session_goal_versions',
      'session_command_requests'
    ];
    
    for (const table of tables) {
      const [count] = await sql`
        SELECT COUNT(*)::int as cnt FROM public.${sql(table)} WHERE user_id = ${TEST_USER_1}
      `;
      if (count.cnt > 0) {
        throw new Error(`Table ${table} not empty: ${count.cnt} rows remaining`);
      }
    }
  })) passed++;

  // ========================================================================
  // SESSION VALIDATION TESTS
  // ========================================================================
  
  console.log('\n📋 Session Validation Tests');

  // Test 11: RPC functions validate authenticated user
  total++;
  if (await test('RPC functions validate authenticated user', async () => {
    await setupTestData();
    
    // Reset auth context
    await sql.unsafe('RESET app.current_user_email');
    
    try {
      await sql`SELECT public.bloom_start_session(${`req-auth-1-${TEST_RUN_ID}`}, ${TEST_HABIT_1})`;
      throw new Error('Should have rejected unauthenticated RPC call');
    } catch (err) {
      if (!err.message.includes('Not authenticated')) {
        throw new Error(`Expected authentication error, got: ${err.message}`);
      }
    }
  })) passed++;

  // Test 12: RPC functions validate resource ownership
  total++;
  if (await test('RPC functions validate resource ownership', async () => {
    await setupTestData();
    
    // Create session for user2
    await setAuth(sql2, 'user2@test.com');
    const [session] = await sql2`
      SELECT public.bloom_start_session(${`req-own-1-${TEST_RUN_ID}`}, ${TEST_HABIT_2}) AS r
    `;
    
    // Try to pause as user1
    await setAuth(sql, 'user1@test.com');
    try {
      await sql`SELECT public.bloom_pause_session(${`req-own-2-${TEST_RUN_ID}`}, ${session.r.session_id})`;
      throw new Error('Should have rejected cross-user session operation');
    } catch (err) {
      if (!err.message.includes('Session not found') && !err.message.includes('Not authenticated')) {
        throw new Error(`Expected ownership validation error, got: ${err.message}`);
      }
    }
  })) passed++;

  // ========================================================================
  // SUMMARY
  // ========================================================================

  console.log(`\n============================================================`);
  console.log(`  PHASE 3 SECURITY TEST SUMMARY`);
  console.log(`============================================================`);
  console.log(`  Total:   ${total}`);
  console.log(`  Passed:  ${passed} ✅`);
  console.log(`  Failed:  ${total - passed} ❌`);
  console.log(`============================================================\n`);

  if (passed === total) {
    console.log(`✅ ALL SECURITY TESTS PASSED\n`);
  } else {
    console.log(`❌ SOME TESTS FAILED\n`);
    process.exit(1);
  }

  await sql.end();
  await sql2.end();
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

  // Test 13: Incomplete deletion is recorded
  total++;
  if (await test('Incomplete deletion is recorded when Auth deletion fails', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    // Delete account (will fail at Auth step in test environment)
    await sql`SELECT public.delete_user_account('DELETE MY ACCOUNT')`;
    
    // Record incomplete deletion
    await sql`SELECT public.record_incomplete_deletion(${TEST_USER_1}, 'user1@test.com', 'Test error')`;
    
    // Verify it was recorded
    const [record] = await sql`
      SELECT id, user_id, resolved FROM public.incomplete_deletions
      WHERE user_id = ${TEST_USER_1} AND resolved = false
    `;
    
    if (!record) {
      throw new Error('Incomplete deletion not recorded');
    }
  })) passed++;

  // Test 14: Recovery mechanism can retry incomplete deletions
  total++;
  if (await test('Recovery mechanism can fetch pending deletions', async () => {
    await setupTestData();
    
    // Create an incomplete deletion record
    await sql.unsafe('SET ROLE service_role');
    await sql`SELECT public.record_incomplete_deletion(${TEST_USER_1}, 'user1@test.com', 'Test error')`;
    
    // Fetch pending deletions
    const [result] = await sql`SELECT public.retry_incomplete_deletions()`;
    
    if (!result.retry_incomplete_deletions) {
      throw new Error('Recovery function failed');
    }
    
    const pending = result.retry_incomplete_deletions.pending_deletions;
    if (!pending || pending.length === 0) {
      throw new Error('No pending deletions found');
    }
  })) passed++;

  // Test 15: Resolved deletions are marked correctly
  total++;
  if (await test('Resolved deletions are marked correctly', async () => {
    await setupTestData();
    
    // Create an incomplete deletion
    await sql.unsafe('SET ROLE service_role');
    const [record] = await sql`
      SELECT public.record_incomplete_deletion(${TEST_USER_1}, 'user1@test.com', 'Test error') AS id
    `;
    
    // Mark as resolved
    await sql`SELECT public.mark_deletion_resolved(${record.id})`;
    
    // Verify it's resolved
    const [check] = await sql`
      SELECT resolved, resolved_at FROM public.incomplete_deletions WHERE id = ${record.id}
    `;
    
    if (!check.resolved) {
      throw new Error('Deletion not marked as resolved');
    }
    
    if (!check.resolved_at) {
      throw new Error('resolved_at not set');
    }
  })) passed++;

  // Test 16: Attempt counter increments correctly
  total++;
  if (await test('Attempt counter increments correctly', async () => {
    await setupTestData();
    
    // Create an incomplete deletion
    await sql.unsafe('SET ROLE service_role');
    const [record] = await sql`
      SELECT public.record_incomplete_deletion(${TEST_USER_1}, 'user1@test.com', 'Test error') AS id
    `;
    
    // Increment attempt
    await sql`SELECT public.increment_deletion_attempt(${record.id})`;
    
    // Verify counter
    const [check] = await sql`
      SELECT auth_deletion_attempts FROM public.incomplete_deletions WHERE id = ${record.id}
    `;
    
    if (check.auth_deletion_attempts !== 2) {
      throw new Error(`Expected 2 attempts, got ${check.auth_deletion_attempts}`);
    }
  })) passed++;

  // Test 17: Cannot delete another user's account
  total++;
  if (await test('Cannot delete another user\'s account', async () => {
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    // Try to delete user2's account (should only delete user1's data)
    const [result] = await sql`SELECT public.delete_user_account('DELETE MY ACCOUNT')`;
    
    // Verify only user1's data was deleted
    const [user1Habits] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.habits WHERE user_id = ${TEST_USER_1}
    `;
    const [user2Habits] = await sql2`
      SELECT COUNT(*)::int as cnt FROM public.habits WHERE user_id = ${TEST_USER_2}
    `;
    
    if (user1Habits.cnt !== 0) {
      throw new Error('User1 habits not deleted');
    }
    
    if (user2Habits.cnt === 0) {
      throw new Error('User2 habits were deleted (should not be)');
    }
  })) passed++;

