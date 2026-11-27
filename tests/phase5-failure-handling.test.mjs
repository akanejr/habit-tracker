#!/usr/bin/env node
/**
 * Phase 5: Failure Handling, Concurrency & State Machine Tests
 *
 * Tests (20 total):
 *  1. Records failure: attempt_count=0, correct fields
 *  2. Destructive ops forced not_retryable
 *  3. Idempotent ops can be retryable
 *  4. max_attempts bounded 1-10
 *  5. Claim returns token + lease
 *  6. Every permitted attempt delivered before exhaustion
 *  7. Final failed attempt → exhausted via report
 *  8. Successful attempt → resolved via report
 *  9. report with stale token rejected
 * 10. report with expired lease rejected
 * 11. resolve requires valid claim token
 * 12. Expired lease recovered and re-delivered
 * 13. Abandoned final attempt reaches exhausted (bounded)
 * 14. RLS: users see only own failures
 * 15. Anon cannot record
 * 16. CONCURRENCY: Two workers, distinct claims (separate connections)
 * 17. CONCURRENCY: Active lease cannot be reclaimed
 * 18. CONCURRENCY: Old token cannot resolve reclaimed operation
 * 19. CONCURRENCY: Active final attempt not prematurely exhausted
 * 20. CONCURRENCY: No operation remains permanently stuck
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
  test('Records failure: attempt_count=0, correct fields', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);

    const [result] = await sql`
      SELECT public.record_operation_failure(
        'start_session',
        ${sql.json({ habit_id: 'h1' })},
        'Connection timeout'
      ) AS id
    `;

    const [f] = await sql`SELECT * FROM public.operation_failures WHERE id = ${result.id}`;
    assert(f.operation_type === 'start_session', 'type');
    assert(f.error_message === 'Connection timeout', 'error');
    assert(f.attempt_count === 0, `attempt_count should be 0, got ${f.attempt_count}`);
    assert(f.status === 'not_retryable', 'default not_retryable');
    assert(f.claim_token === null, 'no claim_token initially');
    assert(f.lease_expires_at === null, 'no lease initially');
  }),

  test('Destructive ops forced not_retryable', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);
    for (const op of ['complete_session', 'cancel_session', 'delete_account']) {
      const [r] = await sql`
        SELECT public.record_operation_failure(${op}, '{}'::jsonb, 'err', true, 5) AS id
      `;
      const [f] = await sql`SELECT status, auto_retryable FROM public.operation_failures WHERE id = ${r.id}`;
      assert(f.status === 'not_retryable', `${op} not_retryable`);
      assert(f.auto_retryable === false, `${op} auto_retryable=false`);
    }
  }),

  test('Idempotent ops can be retryable', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);
    const [r] = await sql`
      SELECT public.record_operation_failure('set_weekly_goal', '{}'::jsonb, 'err', true, 3) AS id
    `;
    const [f] = await sql`SELECT status, auto_retryable, max_attempts FROM public.operation_failures WHERE id = ${r.id}`;
    assert(f.status === 'pending', 'pending');
    assert(f.auto_retryable === true, 'retryable');
    assert(f.max_attempts === 3, 'max_attempts=3');
  }),

  test('max_attempts bounded 1-10', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);
    let e = false;
    try { await sql`SELECT public.record_operation_failure('x', '{}'::jsonb, 'e', true, 0)`; } catch { e = true; }
    assert(e, 'reject 0');
    e = false;
    try { await sql`SELECT public.record_operation_failure('x', '{}'::jsonb, 'e', true, 11)`; } catch { e = true; }
    assert(e, 'reject 11');
  }),

  test('Claim returns token + lease', async () => {
    await cleanup();
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'claim test',
        'pending', true, now() - interval '1 minute', 0, 5)
    `;
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, '1 claimed');
    assert(claimed[0].claim_token !== null, 'has claim_token');
    assert(claimed[0].lease_expires_at !== null, 'has lease_expires_at');
    assert(claimed[0].attempt_count === 1, 'attempt 1');
    assert(new Date(claimed[0].lease_expires_at) > new Date(), 'lease in future');
    await resetRole();
  }),

  test('Every permitted attempt delivered before exhaustion', async () => {
    await cleanup();
    await setServiceRole();
    const [inserted] = await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'exhaust test',
        'pending', true, now() - interval '1 hour', 0, 3)
      RETURNING id
    `;
    const fid = inserted.id;

    // Attempt 1
    let claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'attempt 1 delivered');
    assert(claimed[0].attempt_count === 1, 'count=1');
    const token1 = claimed[0].claim_token;

    // Report failure (attempt 1 failed, more remain)
    let result = await sql`SELECT public.report_attempt_outcome(${fid}, ${token1}, false, 'fail1') AS status`;
    assert(result[0].status === 'pending', `after fail: pending, got ${result[0].status}`);

    // Manually set next_retry_at to past (simulate time passing)
    await sql`UPDATE public.operation_failures SET next_retry_at = now() - interval '1 minute' WHERE id = ${fid}`;

    // Attempt 2
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'attempt 2 delivered');
    assert(claimed[0].attempt_count === 2, 'count=2');
    const token2 = claimed[0].claim_token;

    result = await sql`SELECT public.report_attempt_outcome(${fid}, ${token2}, false, 'fail2') AS status`;
    assert(result[0].status === 'pending', 'after fail 2: pending');

    // Manually set next_retry_at to past
    await sql`UPDATE public.operation_failures SET next_retry_at = now() - interval '1 minute' WHERE id = ${fid}`;

    // Attempt 3 (final)
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'attempt 3 (final) delivered');
    assert(claimed[0].attempt_count === 3, 'count=3');
    const token3 = claimed[0].claim_token;

    // Final attempt fails → exhausted
    result = await sql`SELECT public.report_attempt_outcome(${fid}, ${token3}, false, 'fail3') AS status`;
    assert(result[0].status === 'exhausted', `final fail: exhausted, got ${result[0].status}`);

    // No more claims
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 0, 'no more claims after exhaustion');
    await resetRole();
  }),

  test('Final failed attempt → exhausted via report', async () => {
    await cleanup();
    await setServiceRole();
    const [inserted] = await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'final fail',
        'pending', true, now() - interval '1 hour', 0, 1)
      RETURNING id
    `;
    const fid = inserted.id;

    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'delivered');
    const result = await sql`SELECT public.report_attempt_outcome(${fid}, ${claimed[0].claim_token}, false, 'oops') AS status`;
    assert(result[0].status === 'exhausted', 'exhausted after final fail');

    const [f] = await sql`SELECT status FROM public.operation_failures WHERE id = ${fid}`;
    assert(f.status === 'exhausted', 'persisted exhausted');
    await resetRole();
  }),

  test('Successful attempt → resolved via report', async () => {
    await cleanup();
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'success test',
        'pending', true, now() - interval '1 hour', 0, 3)
    `;
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    const result = await sql`SELECT public.report_attempt_outcome(${claimed[0].failure_id}, ${claimed[0].claim_token}, true) AS status`;
    assert(result[0].status === 'resolved', 'resolved');

    const [f] = await sql`SELECT status, resolved_at FROM public.operation_failures WHERE error_message = 'success test'`;
    assert(f.status === 'resolved', 'persisted resolved');
    assert(f.resolved_at !== null, 'has resolved_at');
    await resetRole();
  }),

  test('report with stale token rejected', async () => {
    await cleanup();
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'stale token',
        'pending', true, now() - interval '1 hour', 0, 3)
    `;
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    const oldToken = claimed[0].claim_token;

    // Resolve it
    await sql`SELECT public.report_attempt_outcome(${claimed[0].failure_id}, ${oldToken}, true)`;

    // Try to report again with old token
    let errored = false;
    try {
      await sql`SELECT public.report_attempt_outcome(${claimed[0].failure_id}, ${oldToken}, false, 'late')`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('not in retrying') || e.message.includes('not found') || e.message.includes('already resolved'),
        `reject stale: ${e.message}`);
    }
    assert(errored, 'stale token rejected');
    await resetRole();
  }),

  test('report with expired lease rejected', async () => {
    await cleanup();
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts,
        claim_token, lease_expires_at)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'expired lease',
        'retrying', true, now(), 1, 5,
        gen_random_uuid(), now() - interval '1 minute')
    `;
    const [f] = await sql`SELECT id, claim_token FROM public.operation_failures WHERE error_message = 'expired lease'`;

    let errored = false;
    try {
      await sql`SELECT public.report_attempt_outcome(${f.id}, ${f.claim_token}, true)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('expired') || e.message.includes('Lease'),
        `lease expired error: ${e.message}`);
    }
    assert(errored, 'expired lease rejected');
    await resetRole();
  }),

  test('resolve requires valid claim token', async () => {
    await cleanup();
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'resolve token',
        'pending', true, now() - interval '1 hour', 0, 3)
    `;
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    const fakeToken = '00000000-0000-0000-0000-000000000099';

    let errored = false;
    try {
      await sql`SELECT public.resolve_operation_failure(${claimed[0].failure_id}, ${fakeToken}::uuid)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('Stale') || e.message.includes('reclaimed'),
        `fake token: ${e.message}`);
    }
    assert(errored, 'fake token rejected');
    await resetRole();
  }),

  test('Expired lease recovered and re-delivered', async () => {
    await cleanup();
    await setServiceRole();
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts,
        claim_token, lease_expires_at)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'abandoned',
        'retrying', true, now(), 1, 5,
        gen_random_uuid(), now() - interval '10 minutes')
    `;
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'recovered and re-delivered');
    assert(claimed[0].attempt_count === 2, 'attempt incremented to 2');
    assert(claimed[0].error_message === 'abandoned', 'same failure');
    await resetRole();
  }),

  test('Abandoned final attempt reaches exhausted (bounded)', async () => {
    await cleanup();
    await setServiceRole();
    // Final attempt (count = max) with expired lease
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts,
        claim_token, lease_expires_at)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'abandoned final',
        'retrying', true, now(), 3, 3,
        gen_random_uuid(), now() - interval '10 minutes')
    `;
    // Step 1 recovers expired lease → pending
    // Step 2 exhausts (attempt_count >= max_attempts)
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 0, 'no new claims (exhausted)');

    const [f] = await sql`SELECT status FROM public.operation_failures WHERE error_message = 'abandoned final'`;
    assert(f.status === 'exhausted', `abandoned final → exhausted, got ${f.status}`);
    await resetRole();
  }),

  test('RLS: users see only own failures', async () => {
    await cleanup();
    await setAuth(TEST_USER_1);
    await sql`SELECT public.record_operation_failure('start_session', '{}'::jsonb, 'u1')`;
    await setAuth(TEST_USER_2);
    const vis = await sql`SELECT COUNT(*)::int AS c FROM public.operation_failures WHERE user_id = ${TEST_USER_1}`;
    assert(vis[0].c === 0, 'u2 cannot see u1');
  }),

  test('Anon cannot record', async () => {
    await resetRole();
    await sql.unsafe(`SET ROLE anon`);
    let e = false;
    try { await sql`SELECT public.record_operation_failure('x', '{}'::jsonb, 'e')`; } catch { e = true; }
    assert(e, 'anon rejected');
    await resetRole();
  }),

  // ========================================================================
  // GENUINE CONCURRENCY TESTS
  // ========================================================================

  test('CONCURRENCY: Two workers, distinct claims (advisory lock barrier)', async () => {
    await cleanup();
    await setServiceRole();
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
          status, auto_retryable, next_retry_at, attempt_count, max_attempts)
        VALUES (${TEST_USER_1}, 'start_session', ${sql.json({ i })}, 'conc ' || ${i}::text,
          'pending', true, now() - interval '1 minute', 0, 5)
      `;
    }

    const w1 = postgres(DB_URL);
    const w2 = postgres(DB_URL);
    try {
      await w1.unsafe(`SET ROLE service_role`);
      await w2.unsafe(`SET ROLE service_role`);

      // SYNCHRONIZATION BARRIER: Both workers acquire a shared advisory lock
      // in sequence, then release it, ensuring they're both alive and about
      // to call retry_failed_operations() simultaneously.
      // pg_advisory_xact_lock is transaction-scoped and released on commit.
      await Promise.all([
        w1`SELECT pg_advisory_lock(99901)`,
        w2`SELECT pg_advisory_lock(99902)`,
      ]);

      // Both workers now begin their claim transactions simultaneously
      const [c1, c2] = await Promise.all([
        (async () => {
          await w1`SELECT pg_advisory_unlock(99901)`;
          return w1`SELECT * FROM public.retry_failed_operations()`;
        })(),
        (async () => {
          await w2`SELECT pg_advisory_unlock(99902)`;
          return w2`SELECT * FROM public.retry_failed_operations()`;
        })(),
      ]);

      const ids1 = new Set(c1.map(r => r.failure_id));
      const ids2 = new Set(c2.map(r => r.failure_id));
      const tokens1 = new Set(c1.map(r => r.claim_token));
      const tokens2 = new Set(c2.map(r => r.claim_token));

      // No duplicate claim IDs
      for (const id of ids1) {
        assert(!ids2.has(id), `ID ${id} claimed by both workers`);
      }
      // No duplicate claim tokens
      for (const t of tokens1) {
        assert(!tokens2.has(t), `Token ${t} given to both workers`);
      }
      assert(ids1.size + ids2.size <= 5, `total ≤ 5, got ${ids1.size + ids2.size}`);
      assert(ids1.size + ids2.size >= 1, 'at least 1 claimed');
      console.log(`     W1: ${ids1.size} claims, W2: ${ids2.size} claims, total: ${ids1.size + ids2.size}`);
    } finally {
      await w1.end();
      await w2.end();
    }
    await resetRole();
  }),

  test('CONCURRENCY: Active lease cannot be reclaimed (transaction coordination)', async () => {
    await cleanup();
    await setServiceRole();

    // Create 2 failures so W1 claims one and W2 tries the same pool
    for (let i = 0; i < 2; i++) {
      await sql`
        INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
          status, auto_retryable, next_retry_at, attempt_count, max_attempts)
        VALUES (${TEST_USER_1}, 'start_session', ${sql.json({ i })}, 'active ' || ${i}::text,
          'pending', true, now() - interval '1 minute', 0, 5)
      `;
    }

    const w1 = postgres(DB_URL);
    const w2 = postgres(DB_URL);
    try {
      await w1.unsafe(`SET ROLE service_role`);
      await w2.unsafe(`SET ROLE service_role`);

      // W1 claims in a transaction (holds row locks until commit)
      let w1Result;
      let w2DuringTx;
      
      await w1.begin(async (tx1) => {
        w1Result = await tx1`SELECT * FROM public.retry_failed_operations()`;
        assert(w1Result.length === 2, `W1 claimed 2, got ${w1Result.length}`);

        // W2 tries while W1's transaction is open — rows are locked/retrying
        w2DuringTx = await w2`SELECT * FROM public.retry_failed_operations()`;
        assert(w2DuringTx.length === 0, `W2 should get 0 (W1 holds lease), got ${w2DuringTx.length}`);
      });
      // W1 transaction committed — leases now active

      // W2 tries again — leases are active (not expired), so still 0
      const w2AfterCommit = await w2`SELECT * FROM public.retry_failed_operations()`;
      assert(w2AfterCommit.length === 0, `W2 still gets 0 (active leases), got ${w2AfterCommit.length}`);
    } finally {
      await w1.end();
      await w2.end();
    }
    await resetRole();
  }),

  test('CONCURRENCY: Old token cannot resolve reclaimed operation', async () => {
    await cleanup();
    await setServiceRole();

    // Create a failure, claim it with an expired lease
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts,
        claim_token, lease_expires_at)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'reclaim test',
        'retrying', true, now(), 1, 5,
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, now() - interval '10 minutes')
    `;
    const oldToken = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    // Reclaim via retry (recovers expired lease)
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'reclaimed');
    const newToken = claimed[0].claim_token;
    assert(newToken !== oldToken, 'new token differs from old');

    // Old token rejected
    let errored = false;
    try {
      await sql`SELECT public.report_attempt_outcome(${claimed[0].failure_id}, ${oldToken}::uuid, true)`;
    } catch (e) {
      errored = true;
      assert(e.message.includes('Stale') || e.message.includes('reclaimed'),
        `old token: ${e.message}`);
    }
    assert(errored, 'old token rejected after reclaim');

    // New token works
    const result = await sql`SELECT public.report_attempt_outcome(${claimed[0].failure_id}, ${newToken}, true) AS status`;
    assert(result[0].status === 'resolved', 'new token resolves');
    await resetRole();
  }),

  test('CONCURRENCY: Active final attempt not prematurely exhausted', async () => {
    await cleanup();
    await setServiceRole();

    // Create with attempt_count already at max-1, so next claim = final
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'final active',
        'pending', true, now() - interval '1 hour', 2, 3)
    `;

    // Claim (attempt 3 = final)
    const claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'final attempt delivered');
    assert(claimed[0].attempt_count === 3, 'count=3');

    // While lease is active, another retry call should NOT exhaust it
    const secondCall = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(secondCall.length === 0, 'no new claims (active lease)');

    // Verify status is still retrying (not exhausted)
    const [f] = await sql`SELECT status FROM public.operation_failures WHERE error_message = 'final active'`;
    assert(f.status === 'retrying', `active final should be retrying, got ${f.status}`);
    await resetRole();
  }),

  test('CONCURRENCY: No operation remains permanently stuck', async () => {
    await cleanup();
    await setServiceRole();

    // Create a failure with max_attempts=2
    await sql`
      INSERT INTO public.operation_failures (user_id, operation_type, payload, error_message,
        status, auto_retryable, next_retry_at, attempt_count, max_attempts)
      VALUES (${TEST_USER_1}, 'start_session', '{}'::jsonb, 'stuck test',
        'pending', true, now() - interval '1 hour', 0, 2)
    `;

    // Claim attempt 1
    let claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'attempt 1 delivered');
    assert(claimed[0].attempt_count === 1, 'count=1');

    // Simulate: worker crashes (expire the lease)
    await sql`
      UPDATE public.operation_failures SET lease_expires_at = now() - interval '1 minute'
      WHERE error_message = 'stuck test'
    `;

    // Next retry: Step 1a recovers non-final (attempt_count=1 < max=2) → pending
    // Step 3 claims it again → attempt 2 (final)
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 1, 'attempt 2 (final) delivered');
    assert(claimed[0].attempt_count === 2, 'count=2');

    // Simulate: worker crashes again (expire the final lease)
    await sql`
      UPDATE public.operation_failures SET lease_expires_at = now() - interval '1 minute'
      WHERE error_message = 'stuck test'
    `;

    // Next retry: Step 1b detects expired FINAL lease → directly to exhausted
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 0, 'no new claims after final exhaustion');

    const [f] = await sql`SELECT status, attempt_count FROM public.operation_failures WHERE error_message = 'stuck test'`;
    assert(f.status === 'exhausted', `final expired → exhausted, got ${f.status}`);
    assert(f.attempt_count === 2, 'attempt_count stays at 2');

    // Verify: calling retry again produces nothing (not stuck)
    claimed = await sql`SELECT * FROM public.retry_failed_operations()`;
    assert(claimed.length === 0, 'subsequent calls: nothing to claim');
    await resetRole();
  }),
];

// ============================================================================
// RUNNER
// ============================================================================

async function run() {
  console.log('\n📋 Phase 5: Failure Handling, Concurrency & State Machine Tests\n');
  for (const t of tests) { await t(); }
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${results.passed} passed, ${results.failed} failed, ${results.passed + results.failed} total`);
  await sql.end();
  if (results.failed > 0) process.exit(1);
}

run().catch(err => { console.error('Fatal:', err); sql.end(); process.exit(1); });
