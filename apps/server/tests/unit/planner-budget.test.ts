import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runModelPlanner } from '../../src/core/module-planner/model-planner.js';
import { fastModelRetries } from '../helpers/model-retries.js';

test('planner uses one attempt budget, retains each invalid response, and propagates cancellation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'planner-budget-'));
  const oldConfig = process.env['MODEL_PROVIDER_CONFIG'];
  const oldMock = process.env['MODEL_PLANNER_MOCK_RESPONSE'];
  try {
    const config = path.join(root, 'provider.json');
    await writeFile(config, JSON.stringify({ models: { test: { model: 'test', provider: 'test', baseURL: 'https://example.invalid/v1', apiKey: 'test-only', wireApi: 'chat-completions' } } }));
    process.env['MODEL_PROVIDER_CONFIG'] = config;
    process.env['MODEL_PLANNER_MOCK_RESPONSE'] = '{}';
    const input = { artifactDir: root, moduleDir: path.join(root, 'modules'), plannerRetries: 2,
      mode: 'auto' as const, viewport: { x: 0, y: 0, width: 100, height: 100 },
      constraints: { avoidSplittingCardsOrRepeatedItems: true, avoidSplittingVisibleText: true, preferSemanticSections: true, smallDecorationsBelongToNearestModule: true },
      design: { height: 100, width: 100, name: 'test', previewImagePath: path.join(root, 'preview.png'), sourceSvgPath: path.join(root, 'source.svg') } };
    const result = await fastModelRetries(t, () => runModelPlanner(input));
    assert.equal(result.status, 'failed');
    assert.equal(result.attemptCount, 3);
    const history = path.join(input.moduleDir, 'planner-history');
    const run = (await readdir(history))[0]!;
    assert.deepEqual((await readdir(path.join(history, run))).sort(), ['1', '2', '3']);
    assert.equal((await readFile(path.join(history, run, '1/planner-response.raw.txt'), 'utf8')).trim(), '{}');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runModelPlanner({ ...input, signal: controller.signal }), { name: 'AbortError' });
  } finally {
    if (oldConfig === undefined) delete process.env['MODEL_PROVIDER_CONFIG']; else process.env['MODEL_PROVIDER_CONFIG'] = oldConfig;
    if (oldMock === undefined) delete process.env['MODEL_PLANNER_MOCK_RESPONSE']; else process.env['MODEL_PLANNER_MOCK_RESPONSE'] = oldMock;
    await rm(root, { recursive: true, force: true });
  }
});
