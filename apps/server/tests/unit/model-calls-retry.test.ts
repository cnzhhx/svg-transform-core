import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolveModelConfigForRole } from '../../src/config/model-provider.js';
import { runModelPlanner } from '../../src/core/module-planner/model-planner.js';
import { getAgentRuntime, type AgentThread, type AgentThreadEvent } from '../../src/pipeline/agent-runtime/index.js';
import { AgentRuntimeError } from '../../src/pipeline/agent-runtime/errors.js';
import { resumeAgentThread, runVisionLlm, startAgentThread } from '../../src/pipeline/llm-client.js';
import { classifySheetWithVision } from '../../src/pipeline/agent-runner/module/module-semantic-pass.js';
import { fastModelRetries } from '../helpers/model-retries.js';

async function collectEvents(events: AsyncIterable<AgentThreadEvent>) {
  const result: AgentThreadEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'model-calls-retry-'));
  const previous = process.env['MODEL_PROVIDER_CONFIG'];
  const previousMock = process.env['MODEL_PLANNER_MOCK_RESPONSE'];
  const configPath = path.join(root, 'models.json');
  await writeFile(configPath, JSON.stringify({ models: { retry: {
    runtime: 'opencode', wireApi: 'responses', provider: 'fixture', model: 'offline-fixture',
    baseURL: 'https://example.invalid/v1', apiKey: 'test-only',
  } } }));
  process.env['MODEL_PROVIDER_CONFIG'] = configPath;
  delete process.env['MODEL_PLANNER_MOCK_RESPONSE'];
  t.mock.method(console, 'warn', () => {});
  t.after(async () => {
    if (previous === undefined) delete process.env['MODEL_PROVIDER_CONFIG']; else process.env['MODEL_PROVIDER_CONFIG'] = previous;
    if (previousMock === undefined) delete process.env['MODEL_PLANNER_MOCK_RESPONSE']; else process.env['MODEL_PLANNER_MOCK_RESPONSE'] = previousMock;
    await rm(root, { recursive: true, force: true });
  });
  const runtime = getAgentRuntime(resolveModelConfigForRole('text', 'retry'));
  const fake: AgentThread = {
    id: 'offline-thread',
    run: async () => assert.fail('unexpected unmocked text model call'),
    runStreamed: async () => assert.fail('unexpected unmocked streamed model call'),
  };
  t.mock.method(runtime, 'startThread', () => fake);
  t.mock.method(runtime, 'resumeThread', () => fake);
  return { root, runtime, fake };
}

test('text and vision entry points both retry TLS failures five times by default', async t => {
  const { root, fake } = await fixture(t);
  let calls = 0;
  t.mock.method(fake, 'run', async () => {
    calls++;
    throw new AgentRuntimeError({ message: 'unknown certificate verification error' });
  });
  await fastModelRetries(t, () => assert.rejects(startAgentThread().run('text'), /certificate/));
  assert.equal(calls, 6);
  calls = 0;
  await fastModelRetries(t, () => assert.rejects(runVisionLlm({ imagePath: path.join(root, 'offline.png'), prompt: 'vision' }), /certificate/));
  assert.equal(calls, 6);
});

test('empty model responses recover through the same shared policy', async t => {
  const { fake } = await fixture(t);
  let calls = 0;
  t.mock.method(fake, 'run', async () => ({ finalResponse: ++calls < 3 ? '' : 'complete', items: [], usage: null }));
  const result = await fastModelRetries(t, () => startAgentThread().run('text'));
  assert.equal(result.finalResponse, 'complete');
  assert.equal(calls, 3);
});

test('streamed failure events and truncated streams use a single retry budget', async t => {
  const { fake } = await fixture(t);
  let calls = 0;
  let cleaned = 0;
  t.mock.method(fake, 'runStreamed', async () => ({ events: (async function* (): AsyncGenerator<AgentThreadEvent> {
    const attempt = ++calls;
    assert.equal(cleaned, attempt - 1);
    try {
      yield { type: 'thread.started', thread_id: 'offline-thread' };
      if (attempt === 1) return;
      yield { type: 'turn.failed', error: { name: 'APIError', message: 'Busy', statusCode: 503, code: 'upstream_busy' } };
    } finally { cleaned++; }
  })() }));
  const events = await fastModelRetries(t, async () => {
    const stream = await startAgentThread().runStreamed('stream');
    return collectEvents(stream.events);
  });
  assert.equal(calls, 6);
  assert.equal(cleaned, 6);
  const failures = events.filter(event => event.type === 'turn.failed');
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0]?.error, { name: 'APIError', message: 'Busy', statusCode: 503, code: 'upstream_busy' });
});

test('invalid credentials stop at the first streamed call', async t => {
  const { fake } = await fixture(t);
  let calls = 0;
  t.mock.method(fake, 'runStreamed', async () => ({ events: (async function* (): AsyncGenerator<AgentThreadEvent> {
    calls++;
    yield { type: 'turn.failed', error: { message: 'Unauthorized', statusCode: 401 } };
  })() }));
  const stream = await startAgentThread().runStreamed('stream');
  assert.equal((await collectEvents(stream.events)).filter(event => event.type === 'turn.failed').length, 1);
  assert.equal(calls, 1);
});

test('empty streamed responses retry and expose only the successful completion', async t => {
  const { fake } = await fixture(t);
  let calls = 0;
  t.mock.method(fake, 'runStreamed', async () => ({ events: (async function* (): AsyncGenerator<AgentThreadEvent> {
    const text = ++calls === 1 ? '' : 'complete';
    yield { type: 'item.completed', item: { id: `message-${calls}`, type: 'agent_message', text } };
    yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } };
  })() }));
  const events = await fastModelRetries(t, async () => {
    const stream = await startAgentThread().runStreamed('stream');
    return collectEvents(stream.events);
  });
  assert.equal(calls, 2);
  assert.equal(events.filter(event => event.type === 'turn.completed').length, 1);
});

test('resumed text calls replace encrypted history without resuming it again', async t => {
  const { runtime, fake } = await fixture(t);
  const fresh: AgentThread = { ...fake, id: 'fresh-thread', run: async () => ({ finalResponse: 'recovered', items: [], usage: null }) };
  t.mock.method(fake, 'run', async () => { throw new AgentRuntimeError({ message: 'Cannot decrypt history', code: 'invalid_encrypted_content', statusCode: 400 }); });
  const replacements = t.mock.method(runtime, 'startThread', () => fresh);
  const thread = resumeAgentThread('broken-thread');
  const result = await fastModelRetries(t, () => thread.run('original prompt'));
  assert.equal(result.finalResponse, 'recovered');
  assert.equal(thread.id, 'fresh-thread');
  assert.equal(replacements.mock.callCount(), 1);
});

test('planner transport errors and invalid responses consume the same six attempts', async t => {
  const { root, fake } = await fixture(t);
  let calls = 0;
  t.mock.method(fake, 'run', async () => {
    if (++calls === 1) throw new AgentRuntimeError({ message: 'unknown certificate verification error' });
    return { finalResponse: '{}', items: [], usage: null };
  });
  const input = { artifactDir: root, moduleDir: path.join(root, 'modules'),
    mode: 'auto' as const, viewport: { x: 0, y: 0, width: 100, height: 100 },
    constraints: { avoidSplittingCardsOrRepeatedItems: true, avoidSplittingVisibleText: true, preferSemanticSections: true, smallDecorationsBelongToNearestModule: true },
    design: { height: 100, width: 100, name: 'test', previewImagePath: path.join(root, 'offline.png'), sourceSvgPath: path.join(root, 'source.svg') } };
  const result = await fastModelRetries(t, () => runModelPlanner(input));
  assert.equal(result.status, 'failed');
  assert.equal(result.attemptCount, 6);
  assert.equal(calls, 6);
  const history = path.join(input.moduleDir, 'planner-history');
  const run = (await readdir(history))[0]!;
  assert.deepEqual((await readdir(path.join(history, run))).sort(), ['1', '2', '3', '4', '5', '6']);
  assert.match(await readFile(path.join(history, run, '1/error.json'), 'utf8'), /certificate/);
  assert.equal((await readFile(path.join(history, run, '6/planner-response.raw.txt'), 'utf8')).trim(), '{}');
});

test('semantic vision transport and JSON validation errors share five retries', async t => {
  const { root, fake } = await fixture(t);
  let calls = 0;
  t.mock.method(fake, 'run', async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET');
    return { finalResponse: calls < 6 ? 'not JSON' : '[]', items: [], usage: null };
  });
  const result = await fastModelRetries(t, () => classifySheetWithVision({
    cells: [], probes: [], moduleDir: root, moduleId: 'module-01',
    moduleRegion: { id: 'module-01', x: 0, y: 0, width: 100, height: 100 },
    sessionId: 'offline-fixture', sheetId: 'sheet-01', sheetPath: path.join(root, 'offline.png'),
  }));
  assert.equal(result.size, 0);
  assert.equal(calls, 6);
});
