import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpencodeRuntime } from '../../src/pipeline/agent-runtime/opencode-runtime.js';
import type { ModelProviderConfig } from '../../src/config/model-provider.js';
import { AgentRuntimeError } from '../../src/pipeline/agent-runtime/errors.js';

test('runtime scopes provider credentials and cleans children/configs when stream consumers stop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
  const previousCli = process.env['OPENCODE_CLI_PATH'];
  const previousSecret = process.env['UNRELATED_SECRET'];
  try {
    const executable = path.join(root, 'fake-opencode');
    await copyFile(fileURLToPath(new URL('../fixtures/fake-opencode.mjs', import.meta.url)), executable);
    await chmod(executable, 0o755);
    process.env['OPENCODE_CLI_PATH'] = executable;
    process.env['UNRELATED_SECRET'] = 'test-secret';
    const config: ModelProviderConfig = { id: 'selected', apiKey: 'fake', baseURL: 'https://example.invalid/v1',
      model: 'fake', provider: 'fixture', providerLabel: 'fixture', runtime: 'opencode', wireApi: 'chat-completions',
      headers: {}, reasoningEffort: 'low', runtimeTrace: false, runtimeTraceSampleChars: 0, thinking: false };
    const runtime = createOpencodeRuntime(config);
    const result = await runtime.startThread({ workingDirectory: root }).run('normal');
    assert.equal(result.finalResponse, 'offline fixture response');
    let probe = JSON.parse(await readFile(path.join(root, 'runtime-probe.json'), 'utf8'));
    assert.equal(probe.scoped, true);
    assert.equal(probe.secretFiltered, true);
    assert.equal(probe.selectedProviderOnly, true);
    assert.equal(await stat(probe.configPath).then(() => true, () => false), false);
    await assert.rejects(runtime.startThread({ workingDirectory: root }).run('api-error'), (error) => {
      assert.ok(error instanceof AgentRuntimeError);
      assert.equal(error.name, 'APIError');
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'invalid_api_key');
      assert.equal(error.message, 'The supplied credential is invalid');
      return true;
    });
    const stream = await runtime.startThread({ workingDirectory: root }).runStreamed('wait-for-cancel');
    for await (const event of stream.events) { if (event.type === 'thread.started') break; }
    probe = JSON.parse(await readFile(path.join(root, 'runtime-probe.json'), 'utf8'));
    assert.throws(() => process.kill(probe.pid, 0), { code: 'ESRCH' });
    assert.equal(await stat(probe.configPath).then(() => true, () => false), false);
  } finally {
    if (previousCli === undefined) delete process.env['OPENCODE_CLI_PATH']; else process.env['OPENCODE_CLI_PATH'] = previousCli;
    if (previousSecret === undefined) delete process.env['UNRELATED_SECRET']; else process.env['UNRELATED_SECRET'] = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});
