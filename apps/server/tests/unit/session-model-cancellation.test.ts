import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { ModelProviderConfig } from '../../src/config/model-provider.js';
import { createOpencodeRuntime } from '../../src/pipeline/agent-runtime/opencode-runtime.js';
import { withAgentProcessScope } from '../../src/pipeline/agent-runtime/process-lifecycle.js';
import { resourcePool } from '../../src/core/resources.js';

test('session cancellation stops its running model and removes waiting calls from the global pool', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'session-model-cancel-'));
  const previousCli = process.env['OPENCODE_CLI_PATH'];
  const previousLimit = process.env['GLOBAL_MODEL_CONCURRENCY'];
  const controller = new AbortController();
  try {
    const executable = path.join(dir, 'fake-opencode');
    await copyFile(fileURLToPath(new URL('../fixtures/fake-opencode.mjs', import.meta.url)), executable);
    await chmod(executable, 0o755);
    process.env['OPENCODE_CLI_PATH'] = executable;
    process.env['GLOBAL_MODEL_CONCURRENCY'] = '1';
    const config: ModelProviderConfig = {
      id: 'selected', apiKey: 'test', baseURL: 'https://example.invalid/v1', headers: {},
      model: 'test', provider: 'test', providerLabel: 'test', runtime: 'opencode',
      wireApi: 'responses', reasoningEffort: 'low', runtimeTrace: false,
      runtimeTraceSampleChars: 0, thinking: false,
    };
    const runtime = createOpencodeRuntime(config);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    await withAgentProcessScope(controller, async () => {
      // No explicit turn signal: the owning session must propagate cancellation.
      const stream = await runtime.startThread({ workingDirectory: dir }).runStreamed('wait-for-cancel');
      let failure = '';
      const active = (async () => {
        for await (const event of stream.events) {
          if (event.type === 'thread.started') started();
          if (event.type === 'turn.failed') failure = event.error.message;
        }
      })();
      await ready;
      const waiting = runtime.startThread({ workingDirectory: dir }).run('must-not-start');
      const canceledWaiter = assert.rejects(waiting, { name: 'AbortError' });
      await setImmediate();
      controller.abort('session-failed');
      await Promise.all([active, canceledWaiter]);
      assert.match(failure, /aborted: session-failed/);
    });
    const probe = JSON.parse(await readFile(path.join(dir, 'runtime-probe.json'), 'utf8'));
    assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' });
    // A different session can acquire the permit once the original process exits.
    const release = await resourcePool('model').lease();
    release();
  } finally {
    controller.abort('test-cleanup');
    if (previousCli === undefined) delete process.env['OPENCODE_CLI_PATH']; else process.env['OPENCODE_CLI_PATH'] = previousCli;
    if (previousLimit === undefined) delete process.env['GLOBAL_MODEL_CONCURRENCY']; else process.env['GLOBAL_MODEL_CONCURRENCY'] = previousLimit;
    await rm(dir, { recursive: true, force: true });
  }
});
