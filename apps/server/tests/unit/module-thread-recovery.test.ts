import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolveDesignTarget } from '../../src/core/design-resolve.js';
import type { SvgVerticalModule } from '../../src/core/svg-vertical-modules/types.js';
import { resolveModelConfigForRole } from '../../src/config/model-provider.js';
import { getAgentRuntime, type AgentInput, type AgentThread, type AgentThreadEvent } from '../../src/pipeline/agent-runtime/index.js';
import { runAgentUnit } from '../../src/pipeline/agent-runner/module/agent-unit.js';
import { persistModuleAgentThreadId } from '../../src/pipeline/agent-runner/module/module-thread-ids.js';
import { sessionStore } from '../../src/session-store.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'module-thread-recovery-'));
  const previous = process.env['MODEL_PROVIDER_CONFIG'];
  const configPath = path.join(root, 'models.json');
  await writeFile(configPath, JSON.stringify({ models: { fixture: { runtime: 'opencode', wireApi: 'responses',
    provider: 'fixture', model: 'offline-fixture', baseURL: 'https://example.invalid', apiKey: 'test-key' } } }));
  process.env['MODEL_PROVIDER_CONFIG'] = configPath;
  const moduleDir = path.join(root, 'module-01');
  await mkdir(moduleDir);
  const svgPath = path.join(root, 'source.svg');
  await writeFile(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><text x="10" y="30">Sample</text></svg>');
  const design = await resolveDesignTarget(svgPath, { format: 'html', scale: 1 });
  const region = { id: 'module-01', x: 0, y: 0, width: 100, height: 80 };
  const module: SvgVerticalModule = { id: region.id, region, diffRegion: region, contentBox: region,
    candidateNodeCount: 1, kind: 'single-page', nodePaths: [], sourceContainerIds: [], score: 0, reason: 'offline recovery fixture' };
  const sessionId = randomUUID();
  sessionStore.create({ id: sessionId, designName: 'fixture', model: 'fixture', svgPath,
    sessionDir: root, artifactDir: root, outputFormat: 'html', outputTarget: design.outputTarget,
    status: 'running', activeStep: 'agent', steps: { agent: { status: 'running' }, verify: { status: 'pending' } },
    logs: [], messages: [], pendingUserMessages: [], result: { moduleAgentThreadIds: { [module.id]: 'broken-history' } } });
  t.after(async () => {
    await sessionStore.flushSessionWrites(sessionId);
    sessionStore.detachSession(sessionId);
    if (previous === undefined) delete process.env['MODEL_PROVIDER_CONFIG']; else process.env['MODEL_PROVIDER_CONFIG'] = previous;
    await rm(root, { recursive: true, force: true });
  });
  const input = { module, moduleSvgPath: svgPath, originalSvgPath: svgPath, design,
    workingDir: moduleDir, artifactDir: root, modulePlan: { outputFormat: 'html' as const, modules: [{ id: module.id, region }] },
    reasoningEffort: 'low' as const, sessionId, controller: new AbortController() };
  return { root, moduleDir, sessionId, input };
}

function thread(id: string, events: (input: AgentInput) => AsyncGenerator<AgentThreadEvent>): AgentThread {
  return { id, run: async () => { throw new Error('not used'); }, runStreamed: async input => ({ events: events(input) }) };
}

test('encrypted history recovery rebuilds the prompt from current files and persists the replacement thread', { timeout: 15000 }, async t => {
  const { moduleDir, sessionId, input } = await fixture(t);
  let oldCleaned = false;
  let recoveredPrompt = '';
  let replacements = 0;
  const old = thread('broken-history', async function* () {
    try {
      await writeFile(path.join(moduleDir, 'module.css'), '.latest-on-disk { color: red; }');
      yield { type: 'turn.failed', error: { message: 'Cannot decrypt history', code: 'invalid_encrypted_content', statusCode: 400 } };
    } finally { oldCleaned = true; }
  });
  const fresh = thread('fresh-history', async function* (prompt) {
    assert.equal(oldCleaned, true, 'the previous execution must drain before a retry starts');
    recoveredPrompt = String(prompt);
    yield { type: 'thread.started', thread_id: 'fresh-history' };
    yield { type: 'turn.failed', error: { message: 'Stop the offline fixture here', statusCode: 400 } };
  });
  const runtime = getAgentRuntime(resolveModelConfigForRole('moduleAgent', 'fixture'));
  t.mock.method(runtime, 'startThread', () => fresh);
  t.mock.method(runtime, 'resumeThread', () => { assert.fail('encrypted history must not resume the broken conversation'); });
  await assert.rejects(runAgentUnit({ ...input, thread: old, revisionPrompt: 'Keep the user revision', extraPrompt: 'Keep extra guidance',
    onThreadReplaced: next => { replacements++; assert.equal(next.id, 'fresh-history'); assert.equal(sessionStore.get(sessionId)?.result.moduleAgentThreadIds?.[input.module.id], undefined); },
    onThreadStarted: threadId => persistModuleAgentThreadId({ sessionId, moduleId: input.module.id, threadId }),
  }), /Stop the offline fixture here/);
  assert.equal(replacements, 1);
  assert.ok(recoveredPrompt.includes('.latest-on-disk'));
  assert.ok(recoveredPrompt.includes('Keep the user revision'));
  assert.ok(recoveredPrompt.includes('Keep extra guidance'));
  assert.equal(sessionStore.get(sessionId)?.result.moduleAgentThreadIds?.[input.module.id], 'fresh-history');
  assert.equal(sessionStore.get(sessionId)?.status, 'running');
  assert.match(await readFile(path.join(moduleDir, 'module.css'), 'utf8'), /latest-on-disk/);
});

test('guidance during module backoff returns an interrupted result without failing the session', async t => {
  const { sessionId, input } = await fixture(t);
  const interrupt = new AbortController();
  const listener = () => {
    if (sessionStore.get(sessionId)?.logs.some(line => line.includes('retry 1/5'))) interrupt.abort('user-guidance-interrupt');
  };
  sessionStore.on(`session:${sessionId}`, listener);
  t.after(() => sessionStore.off(`session:${sessionId}`, listener));
  const old = thread('existing-history', async function* () {
    yield { type: 'turn.failed', error: { message: 'Service unavailable', statusCode: 503 } };
  });
  const result = await runAgentUnit({ ...input, thread: old, interruptSignal: interrupt.signal, interruptLabel: 'user-guidance-interrupt' });
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, 'user-guidance-interrupt');
  assert.equal(input.controller.signal.aborted, false);
  assert.equal(sessionStore.get(sessionId)?.status, 'running');
});
