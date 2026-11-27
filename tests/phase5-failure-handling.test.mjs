#!/usr/bin/env node
/**
 * Phase 5: Failure Handling Tests
 *
 * Tests:
 *  1. Records failure with correct operation type and payload
 *  2. Destructive operations forced to not_retryable
 *  3. Idempotent operations can be marked retryable
 *  4. max_attempts bounded between 1 and 10
 *  5. retry_failed_operations returns only claimed IDs (worker isolation)
 *  6. Every permitted attempt is delivered before exhaustion
 *  7. Exhaustion only after final attempt was delivered and not resolved
 *  8. resolve_operation_failure marks as resolved
 *  9. resolve_operation_failure errors on non-retrying
 * 10. RLS: users can only see own failures
 * 11. Failure recording requires authentication
 * 12. CONCURRENCY: Two workers cannot claim the same failure (real overlap)
 * 13. CONCURRENCY: Claimed failures stay in retrying (not reset to pending)
 * 14. ABANDONED CLAIMS: Stale lease recovered after timeout
 */

import postgres from 'postgres';

const DB_URL = process.env.TEST_DB_URL || 'postgresql://bloom_tester:test123@localhost:5432/bloom_test';
const sql = postgres(DB_URL);

const TEST_USER_1 = '00000000-0000-0000-0000-000000000001';
const TEST_USER_2 = '00000000-0000-0000-0000-000000000002';

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
  await sql`DELETE FROM public.operation_failures WHERE user_id IN (${TEST_USER_1}, ${TEST_USER_2})`;
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
    await setAuth(TEST_USER_1);

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
    assert(failure.attempt_count === 0, 'Initial attempt_count should be 0 (never claimed)');
    assert(failure.status === 'not_retryable', 'Default status should be not_retryable');
  }),

  test('Destructive operations forced to not_retryable', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);

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
    await setAuth(TEST_USER_1);

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
    await setAuth(TEST_USER_1);

    let errored = false;
    try {
      await sql`
        SELECT public.record_operation_failure('test', ${sql.json({})}, 'err', true, 0)
      `;
    } catch (e) { errored = true; }
    assert(errored, 'Should reject max_attempts < 1');

    errored = false;
    try {
      await sql`
        SELECT public.record_operation_failure('test', ${sql.json({})}, 'err', true, 11)
      `;
    } catch (e) { errored = true; }
    assert(errored, 'Should reject max_attempts > 10');
  }),

  test('retry_failed_operations returns ONLY claimed IDs', async () => {
    await cleanup();
    await setServiceRole();

    // Create 2 due failures
    for (let i = 0; i < 2; i++) {
      await sql`
        INSERT INTO public.operation_failures (
          user_id, operation_type, payload, error_message,
          status, auto_retryable, next_retry_at, attempt_count, max_attempts
        ) VALUES (
          ${TEST_USER_1}, 'start_session', ${sql.json({ index: i })},
          'test ' || ${i}::text,
          'pending', true, now() - interval '1 minute', 0, 5
        )
      `;
    }

    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 2, `Should claim exactly 2 failures, got ${claimed.length}`);
    assert(claimed[0].attempt_count === 1, 'First attempt should be 1');
    assert(claimed[1].attempt_count === 1, 'First attempt should be 1');
    await resetRole();
  }),

  test('Every permitted attempt is delivered before exhaustion', async () => {
    await cleanup();
    await setServiceRole();

    // Create a failure with max_attempts = 3
    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'exhaustion test',
        'pending', true, now() - interval '1 hour', 0, 3
      )
    `;

    // Attempt 1: should be delivered
    let claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'Attempt 1: should deliver 1 failure');
    assert(claimed[0].attempt_count === 1, 'Attempt 1: count should be 1');

    // Simulate: worker fails, resolve is NOT called (failure stays 'retrying')
    // Manually set next_retry_at to past and status to pending to simulate
    // the failure not being resolved
    await sql`
      UPDATE public.operation_failures SET
        status = 'pending', next_retry_at = now() - interval '1 minute'
      WHERE error_message = 'exhaustion test'
    `;

    // Attempt 2: should be delivered
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'Attempt 2: should deliver 1 failure');
    assert(claimed[0].attempt_count === 2, 'Attempt 2: count should be 2');

    await sql`
      UPDATE public.operation_failures SET
        status = 'pending', next_retry_at = now() - interval '1 minute'
      WHERE error_message = 'exhaustion test'
    `;

    // Attempt 3 (final): should be delivered
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'Attempt 3 (final): should still deliver');
    assert(claimed[0].attempt_count === 3, 'Attempt 3: count should be 3');

    // Now mark it pending again — next call should EXHAUST it
    await sql`
      UPDATE public.operation_failures SET
        status = 'pending', next_retry_at = now() - interval '1 minute'
      WHERE error_message = 'exhaustion test'
    `;

    // Attempt 4: should NOT be delivered (max reached)
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 0, 'After max attempts: should deliver 0 failures');

    // Verify exhaustion status
    const [failure] = await sql`
      SELECT status FROM public.operation_failures
      WHERE error_message = 'exhaustion test'
    `;
    assert(failure.status === 'exhausted', 'Should be exhausted after all attempts used');
    await resetRole();
  }),

  test('Exhaustion only after final attempt delivered and not resolved', async () => {
    await cleanup();
    await setServiceRole();

    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'resolve before exhaust',
        'pending', true, now() - interval '1 hour', 0, 2
      )
    `;

    // Attempt 1: deliver
    let claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'Should deliver attempt 1');
    const failureId = claimed[0].failure_id;

    // Worker resolves it successfully
    await sql`SELECT public.resolve_operation_failure(${failureId})`;

    const [resolved] = await sql`
      SELECT status, resolved_at FROM public.operation_failures WHERE id = ${failureId}
    `;
    assert(resolved.status === 'resolved', 'Should be resolved');
    assert(resolved.resolved_at !== null, 'Should have resolved_at');

    // Next retry call should NOT touch the resolved failure
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 0, 'No failures to claim');
    await resetRole();
  }),

  test('resolve_operation_failure marks as resolved', async () => {
    await cleanup();
    await setServiceRole();

    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, claimed_at
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'to resolve',
        'retrying', true, now(), now()
      )
    `;

    const [failure] = await sql`
      SELECT id FROM public.operation_failures
      WHERE error_message = 'to resolve'
    `;

    await sql`SELECT public.resolve_operation_failure(${failure.id})`;

    const [resolved] = await sql`
      SELECT status, resolved_at FROM public.operation_failures WHERE id = ${failure.id}
    `;
    assert(resolved.status === 'resolved', 'Should be resolved');
    assert(resolved.resolved_at !== null, 'Should have resolved_at timestamp');
    await resetRole();
  }),

  test('resolve_operation_failure errors on non-retrying', async () => {
    await setServiceRole();

    // Try to resolve a non-existent ID
    let errored = false;
    try {
      await sql`SELECT public.resolve_operation_failure(999999)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('not found') || e.message.includes('not in retrying'),
        'Should mention not found or not retrying');
    }
    assert(errored, 'Should error on non-existent/non-retrying failure');
    await resetRole();
  }),

  test('RLS: users can only see own failures', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);

    await sql`
      SELECT public.record_operation_failure(
        'start_session', ${sql.json({ secret: 'user1-data' })}, 'user1 error'
      )
    `;

    await setAuth(TEST_USER_2);
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
      await sql`SELECT public.record_operation_failure('test', '{}'::jsonb, 'err')`;
    } catch (e) { errored = true; }
    assert(errored, 'Anon should not be able to record failures');
    await resetRole();
  }),

  // ========================================================================
  // CONCURRENCY TESTS
  // ========================================================================

  test('CONCURRENCY: Two workers cannot claim the same failure (real overlap)', async () => {
    await cleanup();

    // Create 5 retryable failures that are due for retry
    await setServiceRole();
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO public.operation_failures (
          user_id, operation_type, payload, error_message,
          status, auto_retryable, next_retry_at, attempt_count, max_attempts
        ) VALUES (
          ${TEST_USER_1}, 'start_session',
          ${sql.json({ index: i })},
          'concurrency test ' || ${i}::text,
          'pending', true, now() - interval '1 minute', 0, 5
        )
      `;
    }

    // Open two SEPARATE database connections (genuine concurrent workers)
    const worker1 = postgres(DB_URL);
    const worker2 = postgres(DB_URL);

    try {
      await worker1.unsafe(`SET ROLE service_role`);
      await worker2.unsafe(`SET ROLE service_role`);

      // Both workers call retry SIMULTANEOUSLY
      const [claimed1, claimed2] = await Promise.all([
        worker1`SELECT * FROM public.retry_failed_operations()`,
        worker2`SELECT * FROM public.retry_failed_operations()`,
      ]);

      // Collect claimed failure IDs
      const ids1 = new Set(claimed1.map(r => r.failure_id));
      const ids2 = new Set(claimed2.map(r => r.failure_id));

      // CRITICAL: No overlap — no failure_id appears in both workers
      for (const id of ids1) {
        assert(!ids2.has(id),
          `FAILURE: ID ${id} was claimed by BOTH workers — SKIP LOCKED broken`);
      }

      // Combined claims should not exceed 5 (total failures)
      const totalClaimed = ids1.size + ids2.size;
      assert(totalClaimed <= 5, `Total claimed should be <= 5, got ${totalClaimed}`);
      assert(totalClaimed >= 1, 'At least one worker should have claimed something');

      console.log(`     Worker 1 claimed: ${ids1.size}, Worker 2 claimed: ${ids2.size}, Total: ${totalClaimed}`);
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
        'pending', true, now() - interval '1 minute', 0, 5
      )
    `;

    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'Should claim 1 failure');

    const [failure] = await sql`
      SELECT status, claimed_at FROM public.operation_failures
      WHERE error_message = 'stays retrying'
    `;
    assert(failure.status === 'retrying',
      `Claimed failure should stay 'retrying', got: ${failure.status}`);
    assert(failure.claimed_at !== null, 'claimed_at should be set');

    // Second retry call should NOT re-claim the same failure
    const secondClaim = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(secondClaim.length === 0,
      'Second retry call should not re-claim already-retrying failures');
    await resetRole();
  }),

  // ========================================================================
  // ABANDONED CLAIM RECOVERY
  // ========================================================================

  test('ABANDONED CLAIMS: Stale lease recovered after timeout', async () => {
    await cleanup();
    await setServiceRole();

    // Simulate an abandoned claim: status='retrying', claimed_at > 5 minutes ago
    await sql`
      INSERT INTO public.operation_failures (
        user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts, claimed_at
      ) VALUES (
        ${TEST_USER_1}, 'start_session', '{}'::jsonb, 'abandoned claim',
        'retrying', true, now() - interval '10 minutes', 1, 5,
        now() - interval '10 minutes'
      )
    `;

    // Call retry — should recover the abandoned claim and re-deliver it
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, `Should recover abandoned claim, got ${claimed.length}`);
    assert(claimed[0].attempt_count === 2, 'Attempt count should increment to 2');
    assert(claimed[0].error_message === 'abandoned claim', 'Should match the abandoned failure');

    // Verify the failure is now 'retrying' with a fresh claimed_at
    const [failure] = await sql`
      SELECT status, claimed_at FROM public.operation_failures
      WHERE error_message = 'abandoned claim'
    `;
    assert(failure.status === 'retrying', 'Should be retrying after recovery');
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
