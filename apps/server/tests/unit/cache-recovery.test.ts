import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedModuleVerification, candidateContext, restoreModuleCandidate, saveModuleCandidate } from '../../src/core/artifact-cache.js';
import { SessionStore } from '../../src/session-store/store.js';
import { getWorkspaceRoot, setWorkspaceRoot } from '../../src/core/paths.js';
import { resolveOutputTarget } from '../../src/core/output-target.js';
import { createAgentEnvironment } from '../../src/pipeline/agent-runtime/environment.js';
import { compareTextBoxes } from '../../src/core/text-diagnostics.js';

test('cache reuses stable inputs, invalidates changed assets, and refuses missing outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'module-cache-'));
  try {
    await writeFile(path.join(root, 'module.svg'), '<svg/>');
    await writeFile(path.join(root, 'icon.png'), 'a');
    const outputs = path.join(root, 'verify');
    await mkdir(outputs);
    let calls = 0;
    const run = async () => {
      calls++;
      for (const name of ['render.png', 'svg.png', 'diff.png']) await writeFile(path.join(outputs, name), String(calls));
      return { diffRatio: 0.03, passed: true, renderPngPath: path.join(outputs, 'render.png'), svgPngPath: path.join(outputs, 'svg.png'), diffPngPath: path.join(outputs, 'diff.png') };
    };
    const options = { moduleDir: root, kind: 'test', context: { scale: 1 }, run };
    await cachedModuleVerification(options);
    await cachedModuleVerification(options);
    assert.equal(calls, 1);
    await writeFile(path.join(root, 'icon.png'), 'b');
    await cachedModuleVerification(options);
    assert.equal(calls, 2);
    await rm(path.join(outputs, 'render.png'));
    await cachedModuleVerification(options);
    assert.equal(calls, 3);
    await cachedModuleVerification({ ...options, context: { scale: 2 } });
    assert.equal(calls, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('best candidate restores matching source and assets but refuses another source context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-'));
  try {
    await writeFile(path.join(root, 'module.svg'), '<svg/>');
    await writeFile(path.join(root, 'module.css'), 'good');
    await writeFile(path.join(root, 'asset.png'), 'good image');
    const context = await candidateContext(root, 'html');
    await saveModuleCandidate(root, 0.01, context);
    await writeFile(path.join(root, 'module.css'), 'bad');
    await writeFile(path.join(root, 'asset.png'), 'bad image');
    assert.equal(await restoreModuleCandidate(root, 0.2, 'other'), false);
    assert.equal(await restoreModuleCandidate(root, 0.2, context), true);
    assert.equal(await readFile(path.join(root, 'module.css'), 'utf8'), 'good');
    assert.equal(await readFile(path.join(root, 'asset.png'), 'utf8'), 'good image');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable snapshots recover interrupted tasks and unacknowledged guidance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-recovery-'));
  const previous = getWorkspaceRoot();
  setWorkspaceRoot(root);
  try {
    const store = new SessionStore();
    const sessionDir = path.join(root, 'jobs', 'test');
    const svgPath = path.join(sessionDir, 'input.svg');
    const outputTarget = resolveOutputTarget({ format: 'html', svgPath });
    store.create({ id: 'test', designName: 'test', model: 'main', svgPath, sessionDir,
      artifactDir: path.join(sessionDir, 'artifacts'), outputFormat: 'html', outputTarget,
      status: 'running', activeStep: 'agent', steps: { agent: { status: 'running' }, verify: { status: 'pending' } },
      logs: [], messages: [], pendingUserMessages: [{ moduleId: 'one', text: 'fix' }],
      result: { modulePlanModules: [{ id: 'one' }] } });
    store.dequeuePendingMessagesForModule('test', 'one');
    for (let i = 0; i < 50; i++) store.addLog('test', `entry-${i}`);
    await store.flushSessionWrites('test');
    const disk = JSON.parse(await readFile(path.join(sessionDir, 'session.json'), 'utf8'));
    assert.equal(disk.logs.at(-1), 'entry-49');
    const resumed = new SessionStore();
    await resumed.hydrateFromDisk();
    await resumed.flushAll();
    assert.equal(resumed.get('test')?.status, 'queued');
    assert.deepEqual(resumed.get('test')?.pendingUserMessages, [{ moduleId: 'one', text: 'fix' }]);
    assert.deepEqual(resumed.get('test')?.result.modulePlanModules, [{ id: 'one' }]);
  } finally { setWorkspaceRoot(previous); await rm(root, { recursive: true, force: true }); }
});

test('agent environment excludes unrelated secrets and text diagnostics report missing/duplicate/offset text', () => {
  assert.deepEqual(createAgentEnvironment({ PATH: '/bin', UNRELATED_API_KEY: 'secret', AGENT_ENV_ALLOWLIST: 'CUSTOM', CUSTOM: 'ok' }), { PATH: '/bin', CUSTOM: 'ok' });
  const box = { text: 'Hello', x: 0, y: 0, width: 30, height: 10 };
  const report = compareTextBoxes([box, { ...box, text: 'Missing' }], [{ ...box, x: 10 }, { ...box, x: 20 }]);
  assert.deepEqual(report.missing, ['Missing']);
  assert.deepEqual(report.duplicates, ['Hello']);
  assert.equal(report.offsets[0]?.distance, 10);
});
