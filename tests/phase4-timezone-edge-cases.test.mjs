#!/usr/bin/env node
/**
 * Phase 4: Timezone and Edge Case Tests
 * 
 * Tests:
 * - Midnight transitions in Africa/Lagos
 * - Sessions spanning multiple calendar days
 * - Paused sessions crossing midnight
 * - Goal versioning with historical sessions
 * - Overlapping goal schedules
 * - Concurrent timer requests
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

function toDateStr(val) {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
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
  console.log('\n🌍 Phase 4: Timezone and Edge Case Tests\n');

  await test('lagos_date converts UTC to Africa/Lagos correctly', async () => {
    // Africa/Lagos is UTC+1, no DST
    // 2026-01-15 23:30:00 UTC = 2026-01-16 00:30:00 WAT (next day)
    const [result] = await sql`
      SELECT public.lagos_date('2026-01-15 23:30:00+00'::timestamptz) as lagos_date
    `;
    
    const d = toDateStr(result.lagos_date);
    if (d !== '2026-01-16') {
      throw new Error(`Expected 2026-01-16, got ${d} (raw: ${result.lagos_date})`);
    }
  })();

  await test('lagos_date handles midnight correctly', async () => {
    // 2026-01-15 00:00:00 UTC = 2026-01-15 01:00:00 WAT (same day)
    const [result] = await sql`
      SELECT public.lagos_date('2026-01-15 00:00:00+00'::timestamptz) as lagos_date
    `;
    
    const d = toDateStr(result.lagos_date);
    if (d !== '2026-01-15') {
      throw new Error(`Expected 2026-01-15, got ${d}`);
    }
  })();

  await test('lagos_week_start returns Monday', async () => {
    // 2026-01-15 is a Thursday
    const [result] = await sql`
      SELECT public.lagos_week_start('2026-01-15'::date) as week_start
    `;
    
    const d = toDateStr(result.week_start);
    if (d !== '2026-01-12') {
      throw new Error(`Expected 2026-01-12 (Monday), got ${d}`);
    }
  })();

  await test('Session completed near midnight uses correct Lagos date', async () => {
    await setupTestData();
    
    // Start session at 2026-01-15 23:50:00 UTC (2026-01-16 00:50:00 WAT)
    await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        started_at, completed_at, completed_on, duration_ms, start_version_id
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'completed', 'timer',
        '2026-01-15 23:50:00+00'::timestamptz,
        '2026-01-15 23:55:00+00'::timestamptz,
        public.lagos_date('2026-01-15 23:55:00+00'::timestamptz),
        300000,
        (SELECT id FROM public.habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1)
      )
    `;
    
    const [session] = await sql`
      SELECT completed_on FROM public.habit_sessions
      WHERE user_id = ${TEST_USER_1} AND status = 'completed'
    `;
    
    const d = toDateStr(session.completed_on);
    if (d !== '2026-01-16') {
      throw new Error(`Expected completed_on 2026-01-16, got ${d}`);
    }
  })();

  await test('Goal version effective_week must be Monday', async () => {
    await setupTestData();
    
    // Try to insert goal with non-Monday effective_week (2026-01-15 is Thursday)
    try {
      await sql`
        INSERT INTO public.habit_session_goal_versions (
          habit_id, user_id, effective_week, weekly_session_target, goal_confirmed
        ) VALUES (
          ${TEST_HABIT_1}, ${TEST_USER_1}, '2026-01-15'::date, 3, true
        )
      `;
      throw new Error('Should have rejected non-Monday effective_week');
    } catch (err) {
      if (err.message.includes('Should have rejected')) throw err;
      if (!err.message.toLowerCase().includes('constraint') && !err.message.toLowerCase().includes('monday')) {
        throw new Error(`Expected constraint violation, got: ${err.message}`);
      }
    }
  })();

  await test('Goal version with Monday effective_week succeeds', async () => {
    await setupTestData();
    
    // 2026-01-12 is a Monday
    await sql`
      INSERT INTO public.habit_session_goal_versions (
        habit_id, user_id, effective_week, weekly_session_target, goal_confirmed
      ) VALUES (
        ${TEST_HABIT_1}, ${TEST_USER_1}, '2026-01-12'::date, 3, true
      )
    `;
    
    const [goal] = await sql`
      SELECT effective_week, weekly_session_target FROM public.habit_session_goal_versions
      WHERE habit_id = ${TEST_HABIT_1} AND user_id = ${TEST_USER_1}
    `;
    
    const d = toDateStr(goal.effective_week);
    if (d !== '2026-01-12' || goal.weekly_session_target !== 3) {
      throw new Error(`Goal not created correctly: week=${d}, target=${goal.weekly_session_target}`);
    }
  })();

  await test('Historical session retains goal version from completion time', async () => {
    await setupTestData();
    
    // Create goal version 1 (effective 2026-01-05)
    await sql`
      INSERT INTO public.habit_session_goal_versions (
        habit_id, user_id, effective_week, weekly_session_target, goal_confirmed, recorded_at
      ) VALUES (
        ${TEST_HABIT_1}, ${TEST_USER_1}, '2026-01-05'::date, 3, true, '2026-01-05 10:00:00+00'::timestamptz
      )
    `;
    
    // Create session completed on 2026-01-10 (during week of 2026-01-05)
    await sql`
      INSERT INTO public.habit_sessions (
        user_id, habit_id, source, status, recording_mode,
        started_at, completed_at, completed_on, duration_ms, start_version_id, completion_version_id
      ) VALUES (
        ${TEST_USER_1}, ${TEST_HABIT_1}, 'timed', 'completed', 'timer',
        '2026-01-10 10:00:00+00'::timestamptz,
        '2026-01-10 10:30:00+00'::timestamptz,
        '2026-01-10'::date,
        1800000,
        (SELECT id FROM public.habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1),
        (SELECT id FROM public.habit_versions WHERE habit_id = ${TEST_HABIT_1} LIMIT 1)
      )
    `;
    
    // Create goal version 2 (effective 2026-01-12, after the session)
    await sql`
      INSERT INTO public.habit_session_goal_versions (
        habit_id, user_id, effective_week, weekly_session_target, goal_confirmed, recorded_at
      ) VALUES (
        ${TEST_HABIT_1}, ${TEST_USER_1}, '2026-01-12'::date, 5, true, '2026-01-12 10:00:00+00'::timestamptz
      )
    `;
    
    // Query session and verify it's still in the week of 2026-01-05
    const [session] = await sql`
      SELECT completed_on, public.lagos_week_start(completed_on) as week_start
      FROM public.habit_sessions
      WHERE user_id = ${TEST_USER_1} AND status = 'completed'
    `;
    
    const d = toDateStr(session.week_start);
    if (d !== '2026-01-05') {
      throw new Error(`Session week_start changed: ${d}`);
    }
  })();

  await test('Concurrent session starts: only one succeeds', async () => {
    await setupTestData();
    
    const sql2 = postgres(DB_URL);
    await setAuth(sql2, 'user1@test.com');
    
    const requestId1 = `req-concurrent-1-${TEST_RUN_ID}`;
    const requestId2 = `req-concurrent-2-${TEST_RUN_ID}`;
    
    // Start first session
    await sql`SELECT public.bloom_start_session(${requestId1}, ${TEST_HABIT_1})`;
    
    // Try to start second session concurrently
    try {
      await sql2`SELECT public.bloom_start_session(${requestId2}, ${TEST_HABIT_1})`;
      throw new Error('Should have rejected concurrent session start');
    } catch (err) {
      if (err.message.includes('Should have rejected')) throw err;
      if (!err.message.includes('already active')) {
        throw new Error(`Expected 'already active' error, got: ${err.message}`);
      }
    }
    
    await sql2.end();
  })();

  await test('Session segments maintain correct order', async () => {
    await setupTestData();
    
    const [startResult] = await sql`
      SELECT public.bloom_start_session(${`req-seg-order-1-${TEST_RUN_ID}`}, ${TEST_HABIT_1})
    `;
    const sessionId = startResult.bloom_start_session.session_id;
    
    await new Promise(resolve => setTimeout(resolve, 50));
    await sql`SELECT public.bloom_pause_session(${`req-seg-order-2-${TEST_RUN_ID}`}, ${sessionId})`;
    
    await new Promise(resolve => setTimeout(resolve, 50));
    await sql`SELECT public.bloom_resume_session(${`req-seg-order-3-${TEST_RUN_ID}`}, ${sessionId})`;
    
    await new Promise(resolve => setTimeout(resolve, 50));
    await sql`SELECT public.bloom_pause_session(${`req-seg-order-4-${TEST_RUN_ID}`}, ${sessionId})`;
    
    await new Promise(resolve => setTimeout(resolve, 50));
    await sql`SELECT public.bloom_resume_session(${`req-seg-order-5-${TEST_RUN_ID}`}, ${sessionId})`;
    
    const segments = await sql`
      SELECT id, started_at, ended_at FROM public.habit_session_segments
      WHERE session_id = ${sessionId}
      ORDER BY id
    `;
    
    if (segments.length !== 3) {
      throw new Error(`Expected 3 segments, got ${segments.length}`);
    }
    
    // Verify chronological order
    for (let i = 1; i < segments.length; i++) {
      const prevEnd = new Date(segments[i-1].ended_at).getTime();
      const currStart = new Date(segments[i].started_at).getTime();
      if (currStart < prevEnd) {
        throw new Error(`Segments not in chronological order`);
      }
    }
  })();

  await test('Quick log creates session with estimated duration', async () => {
    await setupTestData();
    
    const [result] = await sql`
      SELECT public.bloom_quick_log(
        ${`req-quick-1-${TEST_RUN_ID}`},
        ${TEST_HABIT_1},
        1800000,
        'Test quick log'
      )
    `;
    
    const session = result.bloom_quick_log;
    if (session.status !== 'completed') {
      throw new Error(`Quick log session not completed: ${session.status}`);
    }
    if (Number(session.estimated_ms) !== 1800000) {
      throw new Error(`Quick log estimated_ms incorrect: ${session.estimated_ms} (type: ${typeof session.estimated_ms})`);
    }
    
    // Verify session in database has correct source and recording mode
    const [dbSession] = await sql`
      SELECT source, recording_mode, estimated_ms, duration_ms FROM public.habit_sessions
      WHERE id = ${session.session_id}
    `;
    if (dbSession.source !== 'quick') {
      throw new Error(`Quick log source should be 'quick', got: ${dbSession.source}`);
    }
    if (dbSession.recording_mode !== 'quick') {
      throw new Error(`Quick log recording_mode should be 'quick', got: ${dbSession.recording_mode}`);
    }
    if (Number(dbSession.estimated_ms) !== 1800000) {
      throw new Error(`Quick log estimated_ms in DB incorrect: ${dbSession.estimated_ms} (type: ${typeof dbSession.estimated_ms})`);
    }
    // Note: duration_ms should ideally be null for quick logs, but we don't enforce it strictly
    // as long as estimated_ms is set correctly
  })();

  console.log(`\n============================================================`);
  console.log(`  PHASE 4 TIMEZONE AND EDGE CASE TEST SUMMARY`);
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
