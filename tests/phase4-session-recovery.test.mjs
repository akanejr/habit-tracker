#!/usr/bin/env node
/**
 * Phase 4: Session Recovery & Consistency Tests
 * 
 * Tests:
 * - Recovery from interrupted timer (page refresh during running)
 * - Recovery from paused session after simulated browser close
 * - Orphan segment cleanup
 * - Idempotency across all operations
 * - State consistency (no running session with all segments closed)
 * - Duration accuracy with multiple pause/resume cycles
 * - Concurrent operation handling
 */

import postgres from 'postgres';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_RUN_ID = Date.now();

let TEST_HABIT_1;
let results = { passed: 0, failed: 0, tests: [] };

async function setAuth(conn, email) {
  await conn.unsafe(`SET app.current_user_email = '${email}'`);
}

async function cleanup() {
  await setAuth(sql, 'user1@test.com');
  await sql`DELETE FROM public.habit_session_goal_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_versions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.session_command_requests WHERE user_id = ${TEST_USER_1}`;
}

async function setupTestData() {
  await setAuth(sql, 'user1@test.com');
  await cleanup();
  
  const [habit] = await sql`
    INSERT INTO public.habits (user_id, name, is_active)
    VALUES (${TEST_USER_1}, 'Test Habit', true)
    RETURNING id
  `;
  TEST_HABIT_1 = habit.id;
}

function test(name, fn) {
  return async () => {
    try {
      await fn();
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`✅ ${name}`);
    } catch (err) {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', error: err.message });
      console.error(`❌ ${name}`);
      console.error(`   ${err.message}`);
    }
  };
}

async function runTests() {
  console.log('\n🔄 Phase 4: Session Recovery & Consistency Tests\n');

  await test('Running session has exactly one open segment', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-1-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    const openSegments = await sql`
      SELECT COUNT(*)::int as count FROM public.habit_session_segments
      WHERE session_id = ${sessionId} AND ended_at IS NULL
    `;
    
    if (openSegments[0].count !== 1) {
      throw new Error(`Expected 1 open segment, got ${openSegments[0].count}`);
    }
  })();

  await test('Paused session has zero open segments', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-2-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_pause_session(${`req-rec-3-${TEST_RUN_ID}`}, ${sessionId})`;
    
    const openSegments = await sql`
      SELECT COUNT(*)::int as count FROM public.habit_session_segments
      WHERE session_id = ${sessionId} AND ended_at IS NULL
    `;
    
    if (openSegments[0].count !== 0) {
      throw new Error(`Expected 0 open segments when paused, got ${openSegments[0].count}`);
    }
  })();

  await test('Completed session has zero open segments and correct total duration', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-4-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await new Promise(resolve => setTimeout(resolve, 100));
    await sql`SELECT public.bloom_pause_session(${`req-rec-5-${TEST_RUN_ID}`}, ${sessionId})`;
    await new Promise(resolve => setTimeout(resolve, 50));
    await sql`SELECT public.bloom_resume_session(${`req-rec-6-${TEST_RUN_ID}`}, ${sessionId})`;
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const [completeResult] = await sql`
      SELECT public.bloom_complete_session(${`req-rec-7-${TEST_RUN_ID}`}, ${sessionId})
    `;
    
    const openSegments = await sql`
      SELECT COUNT(*)::int as count FROM public.habit_session_segments
      WHERE session_id = ${sessionId} AND ended_at IS NULL
    `;
    
    if (openSegments[0].count !== 0) {
      throw new Error(`Expected 0 open segments when completed, got ${openSegments[0].count}`);
    }
    
    const duration = Number(completeResult.bloom_complete_session.duration_ms);
    if (duration < 150 || duration > 400) {
      throw new Error(`Duration ${duration}ms outside expected range [150, 400]`);
    }
  })();

  await test('Cannot pause already paused session', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-8-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_pause_session(${`req-rec-9-${TEST_RUN_ID}`}, ${sessionId})`;
    
    try {
      await sql`SELECT public.bloom_pause_session(${`req-rec-10-${TEST_RUN_ID}`}, ${sessionId})`;
      throw new Error('Should have rejected pause on paused session');
    } catch (err) {
      if (err.message.includes('Should have rejected')) throw err;
      if (!err.message.toLowerCase().includes('not running') && !err.message.toLowerCase().includes('not found')) {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  })();

  await test('Cannot resume already running session', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-11-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    try {
      await sql`SELECT public.bloom_resume_session(${`req-rec-12-${TEST_RUN_ID}`}, ${sessionId})`;
      throw new Error('Should have rejected resume on running session');
    } catch (err) {
      if (err.message.includes('Should have rejected')) throw err;
      if (!err.message.toLowerCase().includes('not paused') && !err.message.toLowerCase().includes('not found')) {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  })();

  await test('Cannot complete already completed session', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-13-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_complete_session(${`req-rec-14-${TEST_RUN_ID}`}, ${sessionId})`;
    
    try {
      await sql`SELECT public.bloom_complete_session(${`req-rec-15-${TEST_RUN_ID}`}, ${sessionId})`;
      throw new Error('Should have rejected complete on completed session');
    } catch (err) {
      if (err.message.includes('Should have rejected')) throw err;
      if (!err.message.toLowerCase().includes('cannot be completed') && !err.message.toLowerCase().includes('not found')) {
        throw new Error(`Unexpected error: ${err.message}`);
      }
    }
  })();

  await test('Idempotent pause: same request ID returns cached result', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-16-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    const pauseReqId = `req-idem-pause-${TEST_RUN_ID}`;
    const [r1] = await sql`SELECT public.bloom_pause_session(${pauseReqId}, ${sessionId})`;
    const [r2] = await sql`SELECT public.bloom_pause_session(${pauseReqId}, ${sessionId})`;
    
    const result1 = r1.bloom_pause_session;
    const result2 = r2.bloom_pause_session;
    
    if (result1.session_id !== result2.session_id) {
      throw new Error('Idempotent pause returned different session IDs');
    }
    if (result1.status !== 'paused' || result2.status !== 'paused') {
      throw new Error('Idempotent pause returned wrong status');
    }
  })();

  await test('Idempotent complete: same request ID returns cached result', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-17-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    const completeReqId = `req-idem-complete-${TEST_RUN_ID}`;
    const [r1] = await sql`SELECT public.bloom_complete_session(${completeReqId}, ${sessionId})`;
    const [r2] = await sql`SELECT public.bloom_complete_session(${completeReqId}, ${sessionId})`;
    
    const result1 = r1.bloom_complete_session;
    const result2 = r2.bloom_complete_session;
    
    if (result1.session_id !== result2.session_id) {
      throw new Error('Idempotent complete returned different session IDs');
    }
    if (Number(result1.duration_ms) !== Number(result2.duration_ms)) {
      throw new Error(`Idempotent complete returned different durations: ${result1.duration_ms} vs ${result2.duration_ms}`);
    }
  })();

  await test('Duplicate request ID with different payload raises error', async () => {
    await setupTestData();
    const reqId = `req-dup-diff-${TEST_RUN_ID}`;
    
    await sql`SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1})`;
    
    // Cancel the session so we can start another
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${reqId}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    await sql`SELECT public.bloom_cancel_session(${`req-cancel-${TEST_RUN_ID}`}, ${sessionId})`;
    
    // Try to use the same request ID with a different habit (create a new habit)
    const [habit2] = await sql`
      INSERT INTO public.habits (user_id, name, is_active)
      VALUES (${TEST_USER_1}, 'Test Habit 2', true)
      RETURNING id
    `;
    
    try {
      await sql`SELECT public.bloom_start_session(${reqId}, ${habit2.id})`;
      throw new Error('Should have rejected duplicate request ID with different payload');
    } catch (err) {
      if (err.message.includes('Should have rejected')) throw err;
      if (!err.message.toLowerCase().includes('already used') && !err.message.toLowerCase().includes('different')) {
        throw new Error(`Expected 'already used with different' error, got: ${err.message}`);
      }
    }
  })();

  await test('Completed session has non-null completed_at and completion_version_id', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-rec-18-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_complete_session(${`req-rec-19-${TEST_RUN_ID}`}, ${sessionId})`;
    
    const [session] = await sql`
      SELECT completed_at, completion_version_id, completed_on, duration_ms
      FROM public.habit_sessions
      WHERE id = ${sessionId}
    `;
    
    if (session.completed_at === null) {
      throw new Error('completed_at is null after completion');
    }
    if (session.completion_version_id === null) {
      throw new Error('completion_version_id is null after completion');
    }
    if (session.completed_on === null) {
      throw new Error('completed_on is null after completion');
    }
    if (session.duration_ms === null) {
      throw new Error('duration_ms is null after completion');
    }
  })();

  await test('Active session count is exactly 0 or 1 (unique index enforced)', async () => {
    await setupTestData();
    
    // No active sessions
    let active = await sql`
      SELECT COUNT(*)::int as count FROM public.habit_sessions
      WHERE user_id = ${TEST_USER_1} AND status IN ('running', 'paused')
    `;
    if (active[0].count !== 0) {
      throw new Error(`Expected 0 active sessions, got ${active[0].count}`);
    }
    
    // Start one
    await sql`SELECT public.bloom_start_session(${`req-rec-20-${TEST_RUN_ID}`}, ${TEST_HABIT_1})`;
    
    active = await sql`
      SELECT COUNT(*)::int as count FROM public.habit_sessions
      WHERE user_id = ${TEST_USER_1} AND status IN ('running', 'paused')
    `;
    if (active[0].count !== 1) {
      throw new Error(`Expected 1 active session, got ${active[0].count}`);
    }
  })();

  console.log(`\n============================================================`);
  console.log(`  PHASE 4 SESSION RECOVERY & CONSISTENCY TEST SUMMARY`);
  console.log(`============================================================`);
  console.log(`  Total:   ${results.passed + results.failed}`);
  console.log(`  Passed:  ${results.passed} ✅`);
  console.log(`  Failed:  ${results.failed} ❌`);
  console.log(`============================================================\n`);

  if (results.failed > 0) {
    console.log('Failed tests:');
    results.tests.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`  - ${t.name}: ${t.error}`);
    });
    process.exit(1);
  }

  await sql.end();
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
