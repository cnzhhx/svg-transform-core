import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntimeError } from '../../src/pipeline/agent-runtime/errors.js';
import { ModelResponseError, isRetryableModelError, normalizeModelRetries, runWithModelRetries, streamWithModelRetries } from '../../src/pipeline/model-retry.js';
import { withAgentProcessScope } from '../../src/pipeline/agent-runtime/process-lifecycle.js';

test('temporary model failures allow five retries with fixed ten-second waits', async () => {
  let calls = 0;
  const delays: number[] = [];
  const attempts: number[] = [];
  const result = await runWithModelRetries({
    signal: new AbortController().signal,
    run: async () => { if (++calls < 6) throw new AgentRuntimeError({ message: 'Busy', statusCode: 503 }); return 'complete'; },
    onRetry: retry => { attempts.push(retry.number); assert.equal(retry.delayMs, 10000); },
    wait: async ms => { delays.push(ms); },
  });
  assert.equal(result, 'complete');
  assert.equal(calls, 6);
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.deepEqual(delays, [10000, 10000, 10000, 10000, 10000]);
});

test('retry exhaustion preserves the final API error including its metadata', async () => {
  let calls = 0;
  const error = new AgentRuntimeError({ message: 'Rate limited', name: 'APIError', statusCode: 429 });
  await assert.rejects(runWithModelRetries({ signal: new AbortController().signal,
    run: async () => { calls++; throw error; }, onRetry: () => {}, wait: async () => {},
  }), failure => failure === error);
  assert.equal(calls, 6);
});

test('encrypted history failures request a fresh thread; ordinary network recovery resumes the current thread', async () => {
  const failures = [new Error('fetch failed'), new AgentRuntimeError({ message: 'History cannot be parsed', code: 'invalid_encrypted_content', statusCode: 400 })];
  const modes: boolean[] = [];
  await runWithModelRetries({ signal: new AbortController().signal,
    run: async retry => { if (retry) modes.push(retry.freshThread); const error = failures.shift(); if (error) throw error; },
    onRetry: () => {}, wait: async () => {},
  });
  assert.deepEqual(modes, [false, true]);
});

test('permanent failures, cancellation, guidance and local output errors fail immediately', async () => {
  const failures = [
    ...[400, 401, 403, 404, 422].map(statusCode => new AgentRuntimeError({ message: 'Request rejected', statusCode })),
    new Error('APIError: Incorrect API key provided'), new Error('invalid_api_key'),
    new Error('Missing model configuration'), new Error('Failed to start OpenCode CLI: ENOENT'),
    new Error('module-timeout'), new Error('user-guidance-interrupt'), new Error('Missing output files'),
    Object.assign(new Error('canceled'), { name: 'AbortError' }),
  ];
  for (const error of failures) {
    let calls = 0;
    await assert.rejects(runWithModelRetries({ signal: new AbortController().signal,
      run: async () => { calls++; throw error; },
      onRetry: () => assert.fail('must not retry'), wait: async () => assert.fail('must not wait'),
    }), failure => failure === error);
    assert.equal(calls, 1);
  }
  for (const error of [new Error('ECONNRESET'), new Error('HTTP 503'), new Error('rate_limit_exceeded'),
    new Error('unknown certificate verification error'),
    new Error('fetch failed', { cause: Object.assign(new Error('TLS handshake failed'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }),
    new ModelResponseError('Invalid model JSON'),
    new AgentRuntimeError({ message: 'Provider produced an invalid response', name: 'UnknownError' }),
    new AgentRuntimeError({ message: 'Timeout', statusCode: 408 })]) assert.equal(isRetryableModelError(error), true);
});

test('user guidance cancels the real backoff immediately', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runWithModelRetries({ signal: controller.signal,
    run: async () => { calls++; throw new Error('socket closed'); },
    onRetry: () => controller.abort('user-guidance-interrupt'),
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('nested model calls share one budget instead of multiplying retries', async () => {
  let calls = 0;
  let retries = 0;
  const failure = new Error('unknown certificate verification error');
  await assert.rejects(runWithModelRetries({
    run: () => runWithModelRetries({
      run: async () => { calls++; throw failure; },
      onRetry: () => assert.fail('the inner call must not own another retry budget'),
      wait: async () => assert.fail('the inner call must not wait'),
    }),
    onRetry: () => { retries++; },
    wait: async () => {},
  }), error => error === failure);
  assert.equal(calls, 6);
  assert.equal(retries, 5);
});

test('parallel model operations keep independent budgets', async () => {
  const counts = [0, 0];
  await Promise.all(counts.map((_, index) => runWithModelRetries({
    run: () => runWithModelRetries({ run: async () => {
      counts[index]!++;
      await Promise.resolve();
      if (counts[index]! < 6) throw new Error('ECONNRESET');
    } }),
    wait: async () => {},
  })));
  assert.deepEqual(counts, [6, 6]);
});

test('stream retries drain failed attempts before starting and preserve the final error', async () => {
  const order: string[] = [];
  const failure = new AgentRuntimeError({ message: 'Busy', statusCode: 503, code: 'upstream_busy' });
  const received: string[] = [];
  await assert.rejects(async () => {
    for await (const event of streamWithModelRetries({
      maxRetries: 1,
      run: async function* (retry) {
        const attempt = retry?.number ?? 0;
        order.push(`start-${attempt}`);
        try { yield 'progress'; throw failure; }
        finally { await Promise.resolve(); order.push(`closed-${attempt}`); }
      },
      onRetry: () => { order.push('retry'); },
      wait: async () => {},
    })) received.push(event);
  }, error => error === failure);
  assert.deepEqual(received, ['progress', 'progress']);
  assert.deepEqual(order, ['start-0', 'closed-0', 'retry', 'start-1', 'closed-1']);
});

test('closing a stream drains its attempt without submitting another model call', async () => {
  let calls = 0;
  let closed = false;
  const stream = streamWithModelRetries({
    run: async function* () {
      calls++;
      try { yield 1; yield 2; } finally { closed = true; }
    },
    onRetry: () => assert.fail('consumer stop must not retry'),
  });
  assert.equal((await stream.next()).value, 1);
  await stream.return(undefined);
  assert.equal(calls, 1);
  assert.equal(closed, true);
});

test('session cancellation interrupts backoff even without an explicit turn signal', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(withAgentProcessScope(controller, () => runWithModelRetries({
    run: async () => { calls++; throw new Error('socket closed'); },
    onRetry: () => controller.abort('session-stopped'),
  })), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('zero retries disables retry and invalid numeric settings use the shared default', async () => {
  let calls = 0;
  await assert.rejects(runWithModelRetries({ maxRetries: 0,
    run: async () => { calls++; throw new Error('ECONNRESET'); },
    wait: async () => assert.fail('disabled retries must not wait'),
  }), /ECONNRESET/);
  assert.equal(calls, 1);
  assert.equal(normalizeModelRetries(NaN), 5);
  assert.equal(normalizeModelRetries(Infinity), 5);
  assert.equal(normalizeModelRetries(-3), 0);
});
