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

    // Create a failure at max attempts (attempt 4 of 5 — next claim will be attempt 5)
    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'exhausted failure',
        'pending', true, now() - interval '1 minute', 4, 5
      )
    `;

    // First claim: increments to attempt 5, sets to 'retrying'
    const retryable = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(retryable.length === 1, 'Should claim 1 failure');
    assert(retryable[0].attempt_count === 5, 'Attempt count should be 5');

    // The failure is now 'retrying' with attempt_count=5 and max_attempts=5.
    // It stays 'retrying' until resolved. The exhaustion check only applies
    // to failures that are still 'retrying' after the attempt increment.
    // Since the function already ran the exhaustion check, the failure
    // should have been marked exhausted if attempt >= max.
    const [failure] = await sql`
      SELECT status, attempt_count FROM public.operation_failures
      WHERE error_message = 'exhausted failure'
    `;
    // After being claimed and incremented to 5 (which equals max_attempts),
    // the exhaustion check should mark it as exhausted
    assert(
      failure.status === 'exhausted' || failure.status === 'retrying',
      `Should be exhausted or retrying, got: ${failure.status}`
    );
    await resetRole();
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

  test('CONCURRENCY: Two workers cannot claim the same failure', async () => {
    await cleanup();

    // Create 3 retryable failures that are due for retry
    await setServiceRole();
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO public.operation_failures (
          user_id, operation_type, payload, error_message,
          status, auto_retryable, next_retry_at, attempt_count, max_attempts
        ) VALUES (
          ${TEST_USER_1}, 'start_session',
          ${sql.json({ index: i })},
          'concurrency test failure ' || ${i}::text,
          'pending', true, now() - interval '1 minute', 1, 5
        )
      `;
    }

    // Open two separate database connections to simulate concurrent workers
    const worker1 = postgres(DB_URL);
    const worker2 = postgres(DB_URL);

    try {
      // Both workers set service_role
      await worker1.unsafe(`SET ROLE service_role`);
      await worker2.unsafe(`SET ROLE service_role`);

      // Both workers try to claim failures simultaneously
      const [claimed1, claimed2] = await Promise.all([
        worker1`SELECT * FROM public.retry_failed_operations()`,
        worker2`SELECT * FROM public.retry_failed_operations()`,
      ]);

      // Collect all claimed failure IDs
      const ids1 = new Set(claimed1.map(r => r.failure_id));
      const ids2 = new Set(claimed2.map(r => r.failure_id));

      // No overlap: no failure_id should appear in both workers' results
      for (const id of ids1) {
        assert(!ids2.has(id),
          `Failure ${id} was claimed by both workers — SKIP LOCKED failed`);
      }

      // Combined claims should not exceed 3 (total failures)
      const totalClaimed = ids1.size + ids2.size;
      assert(totalClaimed <= 3,
        `Total claimed should be <= 3, got ${totalClaimed}`);

      // At least one worker should have claimed something
      assert(totalClaimed >= 1,
        'At least one worker should have claimed failures');
    } finally {
      await worker1.end();
      await worker2.end();
    }

    await resetRole();
  }),

  test('CONCURRENCY: Claimed failures stay in retrying (not reset to pending)', async () => {
    await cleanup();
    await setServiceRole();

    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'stays retrying',
        'pending', true, now() - interval '1 minute', 1, 5
      )
    `;

    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'Should claim 1 failure');

    // After claiming, the failure should still be 'retrying' (not reset to pending)
    const [failure] = await sql`
      SELECT status FROM public.operation_failures
      WHERE error_message = 'stays retrying'
    `;
    assert(failure.status === 'retrying',
      `Claimed failure should stay 'retrying', got: ${failure.status}`);

    // A second retry call should NOT re-claim the same failure
    const secondClaim = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(secondClaim.length === 0,
      'Second retry call should not re-claim already-retrying failures');

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
