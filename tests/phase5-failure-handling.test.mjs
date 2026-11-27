#!/usr/bin/env node
/**
 * Phase 5: Failure Handling Tests
 *
 * Tests:
 *  1. Records failure with correct operation type and payload
 *  2. Destructive operations forced to not_retryable
 *  3. Idempotent operations can be marked retryable
 *  4. max_attempts bounded between 1 and 10
 *  5. retry_failed_operations respects backoff timing
 *  6. retry_failed_operations marks exhausted operations
 *  7. resolve_operation_failure marks as resolved
 *  8. resolve_operation_failure errors on already-resolved
 *  9. RLS: users can only see own failures
 * 10. Failure recording requires authentication
 */

import postgres from 'postgres';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';

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
  await sql`DELETE FROM public.operation_failures WHERE user_id = ${TEST_USER_1}`;
  await sql`DELETE FROM public.operation_failures WHERE user_id = ${TEST_USER_2}`;
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
  test('Records failure with correct operation type and payload', async () => {
    await cleanup();
    await setAuth(sql, TEST_USER_1);

    const payload = { habit_id: 'test-habit-123', duration: 30000 };
    const [result] = await sql`
      SELECT public.record_operation_failure(
        'start_session',
        ${sql.json(payload)},
        'Connection timeout'
      ) AS id
    `;
    assert(result.id > 0, 'Should return failure ID');

    const [failure] = await sql`
      SELECT * FROM public.operation_failures WHERE id = ${result.id}
    `;
    assert(failure.operation_type === 'start_session', 'Operation type should match');
    assert(failure.error_message === 'Connection timeout', 'Error message should match');
    assert(failure.payload.habit_id === 'test-habit-123', 'Payload should be preserved');
    assert(failure.attempt_count === 1, 'Initial attempt_count should be 1');
    assert(failure.status === 'not_retryable', 'Default status should be not_retryable');
  }),

  test('Destructive operations forced to not_retryable', async () => {
    await cleanup();
    await setAuth(sql, TEST_USER_1);

    const destructiveOps = ['complete_session', 'cancel_session', 'delete_account'];
    for (const op of destructiveOps) {
      const [result] = await sql`
        SELECT public.record_operation_failure(
          ${op},
          ${sql.json({})},
          'test error',
          true,
          5
        ) AS id
      `;
      const [failure] = await sql`
        SELECT status, auto_retryable FROM public.operation_failures WHERE id = ${result.id}
      `;
      assert(failure.status === 'not_retryable',
        `${op} should be not_retryable even when caller sets auto_retryable=true`);
      assert(failure.auto_retryable === false,
        `${op} should have auto_retryable=false`);
    }
  }),

  test('Idempotent operations can be marked retryable', async () => {
    await cleanup();
    await setAuth(sql, TEST_USER_1);

    const [result] = await sql`
      SELECT public.record_operation_failure(
        'set_weekly_goal',
        ${sql.json({ habit_id: 'h1', target: 3 })},
        'Temporary failure',
        true,
        3
      ) AS id
    `;

    const [failure] = await sql`
      SELECT status, auto_retryable, max_attempts FROM public.operation_failures
      WHERE id = ${result.id}
    `;
    assert(failure.status === 'pending', 'Retryable op should be pending');
    assert(failure.auto_retryable === true, 'auto_retryable should be true');
    assert(failure.max_attempts === 3, 'max_attempts should match');
  }),

  test('max_attempts bounded between 1 and 10', async () => {
    await cleanup();
    await setAuth(sql, TEST_USER_1);

    // Too low
    let errored = false;
    try {
      await sql`
        SELECT public.record_operation_failure('test', ${sql.json({})}, 'err', true, 0)
      `;
    } catch (e) {
      errored = true;
    }
    assert(errored, 'Should reject max_attempts < 1');

    // Too high
    errored = false;
    try {
      await sql`
        SELECT public.record_operation_failure('test', ${sql.json({})}, 'err', true, 11)
      `;
    } catch (e) {
      errored = true;
    }
    assert(errored, 'Should reject max_attempts > 10');
  }),

  test('retry_failed_operations respects backoff timing', async () => {
    await cleanup();

    // Create a retryable failure with next_retry_at in the past
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'old failure',
        'pending', true, now() - interval '5 minutes', 1, 5
      )
    `;

    // Also create one with next_retry_at in the future (should not be retried)
    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'future failure',
        'pending', true, now() + interval '1 hour', 1, 5
      )
    `;
    await resetRole();

    // Call retry (service_role)
    await setServiceRole();
    const retryable = await sql`SELECT * FROM public.retry_failed_operations()`;
    await resetRole();

    assert(retryable.length === 1, `Should retry 1 due failure, got ${retryable.length}`);
    assert(retryable[0].operation_type === 'start_session', 'Should match operation type');
    assert(retryable[0].attempt_count === 2, 'Attempt count should increment to 2');
  }),

  test('retry_failed_operations marks exhausted operations', async () => {
    await cleanup();
    await setServiceRole();

    // Create a failure at max attempts
    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'exhausted failure',
        'pending', true, now() - interval '1 minute', 4, 5
      )
    `;

    const retryable = await sql`SELECT * FROM public.retry_failed_operations()`;
    await resetRole();

    // Should have been returned as retrying (attempt 5) and then marked back to pending
    // But after this retry, next call should exhaust it
    await setServiceRole();
    // Move next_retry_at to past for another retry cycle
    await sql`
      UPDATE public.operation_failures SET next_retry_at = now() - interval '1 minute'
      WHERE user_id = ${TEST_USER_1} AND status = 'pending'
    `;
    const secondRetry = await sql`SELECT * FROM public.retry_failed_operations()`;
    await resetRole();

    // This retry should exhaust (attempt_count >= max_attempts)
    const exhausted = await sql`
      SELECT status FROM public.operation_failures
      WHERE user_id = ${TEST_USER_1} AND error_message = 'exhausted failure'
    `;
    assert(
      exhausted.some(r => r.status === 'exhausted'),
      'Should mark as exhausted after max_attempts'
    );
  }),

  test('resolve_operation_failure marks as resolved', async () => {
    await cleanup();
    await setServiceRole();

    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'to resolve',
        'pending', true, now()
      )
    `;

    const [failure] = await sql`
      SELECT id FROM public.operation_failures
      WHERE user_id = ${TEST_USER_1} AND error_message = 'to resolve'
    `;

    await sql`SELECT public.resolve_operation_failure(${failure.id})`;

    const [resolved] = await sql`
      SELECT status, resolved_at FROM public.operation_failures WHERE id = ${failure.id}
    `;
    assert(resolved.status === 'resolved', 'Should be resolved');
    assert(resolved.resolved_at !== null, 'Should have resolved_at timestamp');
    await resetRole();
  }),

  test('resolve_operation_failure errors on non-existent ID', async () => {
    await setServiceRole();
    let errored = false;
    try {
      await sql`SELECT public.resolve_operation_failure(999999)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('not found') || e.message.includes('already'),
        'Should mention not found');
    }
    assert(errored, 'Should error on non-existent failure ID');
    await resetRole();
  }),

  test('RLS: users can only see own failures', async () => {
    await cleanup();
    await setAuth(sql, TEST_USER_1);

    await sql`
      SELECT public.record_operation_failure(
        'start_session', ${sql.json({ secret: 'user1-data' })}, 'user1 error'
      )
    `;

    // User 2 should not see user 1's failures
    await setAuth(sql, TEST_USER_2);
    const visible = await sql`
      SELECT COUNT(*)::int AS count FROM public.operation_failures
      WHERE user_id = ${TEST_USER_1}
    `;
    assert(visible[0].count === 0, 'User 2 should not see User 1 failures');
  }),

  test('Failure recording requires authentication', async () => {
    await resetRole();
    await sql.unsafe(`SET ROLE anon`);

    let errored = false;
    try {
      await sql`
        SELECT public.record_operation_failure('test', '{}'::jsonb, 'err')
      `;
    } catch (e) {
      errored = true;
    }
    assert(errored, 'Anon should not be able to record failures');
    await resetRole();
  }),
];

// ============================================================================
// RUNNER
// ============================================================================

async function run() {
  console.log('\n📋 Phase 5: Failure Handling Tests\n');

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
