#!/usr/bin/env node
/**
 * Phase 4: Timer Reliability Tests
 * 
 * Tests timer behavior across:
 * - Page refreshes and browser restarts
 * - Pause/resume accuracy
 * - Session recovery from interruptions
 * - Multiple active timer prevention
 * - Duration calculation accuracy
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
  await sql`DELETE FROM public.habit_session_segments WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habit_sessions WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.habits WHERE user_id = ${TEST_USER_1}`;
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
  console.log('\n🔬 Phase 4: Timer Reliability Tests\n');

  await test('Timer starts with accurate timestamp', async () => {
    await setupTestData();
    const before = Date.now();
    const [result] = await sql`
      SELECT public.bloom_start_session(${`req-start-1-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const after = Date.now();
    
    const session = result.bloom_start_session;
    const startedAt = new Date(session.started_at).getTime();
    
    if (startedAt < before - 1000 || startedAt > after + 1000) {
      throw new Error(`Start timestamp inaccurate: ${startedAt} not in [${before}, ${after}]`);
    }
  })();

  await test('Timer pause creates segment with accurate end time', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-2-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const before = Date.now();
    await sql`SELECT public.bloom_pause_session(${`req-pause-1-${TEST_RUN_ID}`}, ${sessionId})`;
    const after = Date.now();
    
    const [segment] = await sql`
      SELECT ended_at FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
    `;
    
    const endedAt = new Date(segment.ended_at).getTime();
    if (endedAt < before - 1000 || endedAt > after + 1000) {
      throw new Error(`Segment end time inaccurate: ${endedAt} not in [${before}, ${after}]`);
    }
  })();

  await test('Timer resume creates new segment', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-3-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_pause_session(${`req-pause-2-${TEST_RUN_ID}`}, ${sessionId})`;
    await sql`SELECT public.bloom_resume_session(${`req-resume-1-${TEST_RUN_ID}`}, ${sessionId})`;
    
    const segments = await sql`
      SELECT id FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
      ORDER BY id
    `;
    
    if (segments.length !== 2) {
      throw new Error(`Expected 2 segments, got ${segments.length}`);
    }
  })();

  await test('Completed session calculates accurate duration from segments', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-4-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await new Promise(resolve => setTimeout(resolve, 150));
    await sql`SELECT public.bloom_pause_session(${`req-pause-3-${TEST_RUN_ID}`}, ${sessionId})`;
    await new Promise(resolve => setTimeout(resolve, 100));
    await sql`SELECT public.bloom_resume_session(${`req-resume-2-${TEST_RUN_ID}`}, ${sessionId})`;
    await new Promise(resolve => setTimeout(resolve, 150));
    
    const [completeResult] = await sql`
      SELECT public.bloom_complete_session(${`req-complete-1-${TEST_RUN_ID}`}, ${sessionId})
    `;
    
    const duration = completeResult.bloom_complete_session.duration_ms;
    if (duration < 250 || duration > 500) {
      throw new Error(`Duration inaccurate: ${duration}ms not in expected range [250, 500]`);
    }
  })();

  await test('Cannot start second timer while one is running', async () => {
    await setupTestData();
    await sql`SELECT public.bloom_start_session(${`req-start-5-${TEST_RUN_ID}`}, ${TEST_HABIT_1})`;
    
    try {
      await sql`SELECT public.bloom_start_session(${`req-start-6-${TEST_RUN_ID}`}, ${TEST_HABIT_1})`;
      throw new Error('Should have rejected second active timer');
    } catch (err) {
      if (!err.message.includes('already active')) {
        throw new Error(`Expected 'already active' error, got: ${err.message}`);
      }
    }
  })();

  await test('Cannot start second timer while one is paused', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-7-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_pause_session(${`req-pause-4-${TEST_RUN_ID}`}, ${sessionId})`;
    
    try {
      await sql`SELECT public.bloom_start_session(${`req-start-8-${TEST_RUN_ID}`}, ${TEST_HABIT_1})`;
      throw new Error('Should have rejected second timer while paused');
    } catch (err) {
      if (!err.message.includes('already active')) {
        throw new Error(`Expected 'already active' error, got: ${err.message}`);
      }
    }
  })();

  await test('Session survives simulated page refresh (re-query)', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-9-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    // Simulate page refresh by re-querying
    const [session] = await sql`
      SELECT id, status, started_at FROM public.habit_sessions
      WHERE id = ${sessionId}
    `;
    
    const [segment] = await sql`
      SELECT id, started_at, ended_at FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
    `;
    
    if (session.status !== 'running') {
      throw new Error(`Session status changed: ${session.status}`);
    }
    if (segment.ended_at !== null) {
      throw new Error('Segment was closed unexpectedly');
    }
  })();

  await test('Paused session survives simulated browser restart', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-10-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_pause_session(${`req-pause-5-${TEST_RUN_ID}`}, ${sessionId})`;
    
    // Simulate browser restart by re-querying
    const [session] = await sql`
      SELECT id, status FROM public.habit_sessions
      WHERE id = ${sessionId}
    `;
    
    const [segment] = await sql`
      SELECT ended_at FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
    `;
    
    if (session.status !== 'paused') {
      throw new Error(`Session status changed: ${session.status}`);
    }
    if (segment.ended_at === null) {
      throw new Error('Segment should be closed when paused');
    }
  })();

  await test('Cancelled session closes open segment', async () => {
    await setupTestData();
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-start-11-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await sql`SELECT public.bloom_cancel_session(${`req-cancel-1-${TEST_RUN_ID}`}, ${sessionId})`;
    
    const [segment] = await sql`
      SELECT ended_at FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
    `;
    
    if (segment.ended_at === null) {
      throw new Error('Segment not closed on cancel');
    }
  })();

  await test('Duplicate request ID returns cached result', async () => {
    await setupTestData();
    const requestId = `req-dup-1-${TEST_RUN_ID}`;
    
    const [result1] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1})
    `;
    
    const [result2] = await sql`
      SELECT public.bloom_start_session(${requestId}, ${TEST_HABIT_1})
    `;
    
    if (result1.bloom_start_session.session_id !== result2.bloom_start_session.session_id) {
      throw new Error('Duplicate request ID created different sessions');
    }
  })();

  console.log(`\n============================================================`);
  console.log(`  PHASE 4 TIMER RELIABILITY TEST SUMMARY`);
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
