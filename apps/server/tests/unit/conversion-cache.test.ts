import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { getBackendConfig } from '../../src/config/backend.js';
import { fingerprintFiles, moduleInputFiles } from '../../src/core/artifact-cache.js';
import { hasValidModuleCheckpoint, saveModuleCheckpoint } from '../../src/pipeline/agent-runner/module/module-checkpoint.js';

test('legacy conversion checkpoints expire, current checkpoints reuse inputs and reject changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversion-checkpoint-'));
  try {
    const modulePlanPath = path.join(root, 'plan.json');
    const scaffoldHtmlPath = path.join(root, 'scaffold.html');
    await writeFile(modulePlanPath, '{}');
    await writeFile(scaffoldHtmlPath, '<main></main>');
    await writeFile(path.join(root, 'module.svg'), '<svg/>');
    const input = { moduleDir: root, modulePlanPath, scaffoldHtmlPath, model: 'fixture', format: 'html', scale: 1 };
    const config = getBackendConfig();
    const legacy = await fingerprintFiles([...await moduleInputFiles(root), modulePlanPath, scaffoldHtmlPath,
      config.modelProvider.configPath, fileURLToPath(new URL('../../package.json', import.meta.url))], {
      version: 1, context: { model: 'fixture', format: 'html', scale: 1 }, diff: config.diff,
      browser: config.browser, node: process.version,
    });
    await writeFile(path.join(root, '.completed-module.json'), JSON.stringify({ signature: legacy }));
    assert.equal(await hasValidModuleCheckpoint(input), false);
    await saveModuleCheckpoint(input);
    assert.equal(await hasValidModuleCheckpoint(input), true);
    assert.equal(await hasValidModuleCheckpoint({ ...input, scale: 2 }), false);
    assert.equal(await hasValidModuleCheckpoint({ ...input, format: 'flutter' }), false);
    await writeFile(path.join(root, 'module.svg'), '<svg><text>updated</text></svg>');
    assert.equal(await hasValidModuleCheckpoint(input), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
