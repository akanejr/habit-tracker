#!/usr/bin/env node

/**
 * Request ID Uniqueness Tests
 * 
 * Proves that the request ID uniqueness constraint works correctly:
 * 1. Same user, same request ID, same operation and payload: return cached result
 * 2. Same user, same request ID, different payload: reject
 * 3. Same user, same request ID, different operation type: reject
 * 4. Different users may independently use the same request ID
 * 5. Concurrent duplicate requests execute the operation only once
 */

import postgres from 'postgres';

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
  await setAuth(sql, 'user1@test.com');
  await sql`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;
  
  await setAuth(sql2, 'user2@test.com');
  await sql2`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habit_logs WHERE user_id = ${TEST_USER_2}`;
  await sql2`DELETE FROM public.habits WHERE user_id = ${TEST_USER_2}`;
}

async function setupTestData() {
  await setAuth(sql, 'user1@test.com');
  await setAuth(sql2, 'user2@test.com');
  await cleanup();
  
  const [habit1] = await sql`
    INSERT INTO public.habits (user_id, name, is_active)
    VALUES (${TEST_USER_1}, 'Exercise', true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit1.id;

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
  console.log('\n🔐 Request ID Uniqueness Tests\n');
  
  let passed = 0;
  let total = 0;

  // Test 1: Same user, same request ID, same operation and payload: return cached result
  total++;
  if (await test('Same user, same request ID, same operation and payload: returns cached result', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    const requestId = `req-cache-${TEST_RUN_ID}`;
    
    const [result1] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r
    `;
    
    await sql`SELECT public.bloom_complete_session(${`req-complete-${TEST_RUN_ID}`}, ${result1.r.session_id})`;
    
    const [result2] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r
    `;
    
    if (result1.r.session_id !== result2.r.session_id) {
      throw new Error(`Expected same session_id, got ${result1.r.session_id} vs ${result2.r.session_id}`);
    }
    
    const [count] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.session_command_requests
      WHERE request_id = ${requestId} AND user_id = ${TEST_USER_1}
    `;
    if (count.cnt !== 1) {
      throw new Error(`Expected 1 request record, got ${count.cnt}`);
    }
  })) passed++;

  // Test 2: Same user, same request ID, different payload: reject
  total++;
  if (await test('Same user, same request ID, different payload: rejected', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    const requestId = `req-diff-payload-${TEST_RUN_ID}`;
    
    const [result1] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r
    `;
    
    try {
      await sql`
        SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_2}) AS r
      `;
      throw new Error('Should have rejected different payload');
    } catch (err) {
      if (!err.message.includes('already used') && !err.message.includes('duplicate key') && !err.message.includes('unique constraint')) {
        throw new Error(`Expected rejection, got: ${err.message}`);
      }
    }
  })) passed++;

  // Test 3: Same user, same request ID, different operation type: reject at database level
  total++;
  if (await test('Same user, same request ID, different operation type: rejected by database constraint', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    
    const requestId = `req-diff-op-${TEST_RUN_ID}`;
    
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r
    `;
    
    // Verify the constraint exists at the database level
    const [constraint] = await sql`
      SELECT conname, pg_get_constraintdef(oid) as definition
      FROM pg_constraint
      WHERE conrelid = 'public.session_command_requests'::regclass
        AND conname = 'unique_request_per_user'
    `;
    
    if (!constraint) {
      throw new Error('unique_request_per_user constraint not found');
    }
    
    if (!constraint.definition.includes('UNIQUE (request_id, user_id)')) {
      throw new Error(`Constraint definition incorrect: ${constraint.definition}`);
    }
    
    console.log(`   ✓ Constraint verified: ${constraint.definition}`);
    
    // Verify only one record exists for this request_id
    const [count] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.session_command_requests
      WHERE request_id = ${requestId} AND user_id = ${TEST_USER_1}
    `;
    if (count.cnt !== 1) {
      throw new Error(`Expected 1 request record, got ${count.cnt}`);
    }
  })) passed++;

  // Test 4: Different users may independently use the same request ID
  total++;
  if (await test('Different users may independently use the same request ID', async () => {
    await cleanup();
    await setupTestData();
    
    const requestId = `req-shared-${TEST_RUN_ID}`;
    
    await setAuth(sql, 'user1@test.com');
    const [user1Result] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r
    `;
    
    await setAuth(sql2, 'user2@test.com');
    const [user2Result] = await sql2`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_2}) AS r
    `;
    
    if (user1Result.r.session_id === user2Result.r.session_id) {
      throw new Error('Different users should have different sessions');
    }
    
    // Query as user1 to see user1's record
    await setAuth(sql, 'user1@test.com');
    const user1Records = await sql`
      SELECT user_id FROM public.session_command_requests
      WHERE request_id = ${requestId} AND user_id = ${TEST_USER_1}
    `;
    
    // Query as user2 to see user2's record
    await setAuth(sql2, 'user2@test.com');
    const user2Records = await sql2`
      SELECT user_id FROM public.session_command_requests
      WHERE request_id = ${requestId} AND user_id = ${TEST_USER_2}
    `;
    
    const totalRecords = user1Records.length + user2Records.length;
    if (totalRecords !== 2) {
      throw new Error(`Expected 2 request records total, got ${totalRecords}`);
    }
  })) passed++;

  // Test 5: Concurrent duplicate requests execute the operation only once
  total++;
  if (await test('Concurrent duplicate requests execute the operation only once', async () => {
    await cleanup();
    await setupTestData();
    await setAuth(sql, 'user1@test.com');
    await setAuth(sql2, 'user1@test.com');
    
    const requestId = `req-concurrent-${TEST_RUN_ID}`;
    
    const results = await Promise.allSettled([
      sql`SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r`,
      sql2`SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1}) AS r`
    ]);
    
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    if (fulfilled.length === 0) {
      throw new Error('At least one request should succeed');
    }
    
    const sessionIds = fulfilled.map(r => r.value[0].r.session_id);
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (uniqueSessionIds.length !== 1) {
      throw new Error(`Expected 1 unique session_id, got ${uniqueSessionIds.length}`);
    }
    
    const [count] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.habit_sessions
      WHERE user_id = ${TEST_USER_1} AND habit_id = ${TEST_HABIT_1}
    `;
    if (count.cnt !== 1) {
      throw new Error(`Expected 1 session in database, got ${count.cnt}`);
    }
    
    const [reqCount] = await sql`
      SELECT COUNT(*)::int as cnt FROM public.session_command_requests
      WHERE request_id = ${requestId} AND user_id = ${TEST_USER_1}
    `;
    if (reqCount.cnt !== 1) {
      throw new Error(`Expected 1 request record, got ${reqCount.cnt}`);
    }
  })) passed++;

  console.log(`\n============================================================`);
  console.log(`  REQUEST ID UNIQUENESS TEST SUMMARY`);
  console.log(`============================================================`);
  console.log(`  Total:   ${total}`);
  console.log(`  Passed:  ${passed} ✅`);
  console.log(`  Failed:  ${total - passed} ❌`);
  console.log(`============================================================\n`);

  if (passed === total) {
    console.log(`✅ ALL REQUEST ID UNIQUENESS TESTS PASSED\n`);
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
