import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptiveModulePlan } from '../../src/core/svg-vertical-modules/entry.js';
import { cropAllModuleSvgs } from '../../src/core/svg-vertical-modules/module-svg-crop.js';
import { validateSvgInput } from '../../src/core/svg-parse.js';

test('fixed long-page, masked paths and shared backgrounds survive analysis and SVG cropping', async () => {
  const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url));
  for (const name of (await readdir(fixtures)).filter((file) => file.endsWith('.svg'))) {
    const root = await mkdtemp(path.join(process.cwd(), '.svg-fixture-'));
    try {
      const input = path.join(root, name);
      await copyFile(path.join(fixtures, name), input);
      const size = validateSvgInput(await readFile(input, 'utf8'));
      const plan = await createAdaptiveModulePlan({ inputPath: input, planner: 'script', artifactDir: path.join(root, 'artifacts') });
      assert.equal(plan.report.modules.length, 1);
      assert.equal(plan.report.design.width, size.width);
      const crops = await cropAllModuleSvgs({ originalSvgPath: input, modules: plan.report.modules,
        modulesRootDir: plan.moduleDir, scale: 1, sharedLayers: plan.report.sharedLayers });
      assert.equal(crops.size, 1);
      const cropped = await readFile(path.join(plan.moduleDir, plan.report.modules[0]!.id, 'module.svg'), 'utf8');
      assert.ok(validateSvgInput(cropped).nodeCount > 1);
      if (name === 'masked-path-text.svg') assert.match(cropped, /clipPath/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
