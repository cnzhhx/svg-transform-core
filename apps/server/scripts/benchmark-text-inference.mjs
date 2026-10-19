// Run from apps/server: node --import tsx scripts/benchmark-text-inference.mjs /path/to/old/text-style-inference.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { evaluatePage, launchEdge, shutdownBrowserPool } from '../src/core/cdp.ts';
import { inferTextStyles } from '../src/core/text-style-inference.ts';

const baselinePath = process.argv[2];
if (!baselinePath) throw new Error('Supply the previous text-style-inference.ts as the first argument.');
const oldSource = await readFile(baselinePath, 'utf8');
const compiled = ts.transpileModule(oldSource, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText.replace(/from ["']\.\/cdp\.js["']/g, `from ${JSON.stringify(new URL('../src/core/cdp.ts', import.meta.url).href)}`);
const { inferTextStyles: baseline } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const root = await mkdtemp(path.join(os.tmpdir(), 'text-inference-benchmark-'));
try {
  const browser = await launchEdge();
  let fixture;
  try {
    fixture = await evaluatePage({ port: browser.port, url: 'about:blank', readyExpression: 'true',
      viewportWidth: 1100, viewportHeight: 360, maxRetries: 0,
      expression: `(() => {
        const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 360;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1100, 360);
        const blocks = Array.from({ length: 48 }, (_, index) => {
          const text = 'Sample ' + String(index).padStart(2, '0');
          const size = 16 + index % 3 * 2; const color = index % 2 ? '#243746' : '#111111';
          const x = index % 8 * 135 + 10; const y = Math.floor(index / 8) * 55 + 30;
          ctx.font = '400 ' + size + 'px Arial'; ctx.fillStyle = color; ctx.fillText(text, x, y);
          const m = ctx.measureText(text);
          return { id: 'text-' + index, text, color, region: {
            x: x - m.actualBoundingBoxLeft, y: y - m.actualBoundingBoxAscent,
            width: Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight),
            height: Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent),
          }, currentDeclarations: { 'font-family': 'Arial', 'font-size': size + 'px', 'font-weight': '400' } };
        });
        return { blocks, png: canvas.toDataURL('image/png').split(',')[1] };
      })()`,
    });
  } finally { await browser.close(); }
  const targetImagePath = path.join(root, 'fixture.png');
  await writeFile(targetImagePath, Buffer.from(fixture.png, 'base64'));
  const input = { blocks: fixture.blocks, targetImagePath };
  await inferTextStyles({ ...input, blocks: fixture.blocks.slice(0, 2) });
  const runs = { baseline: [], optimized: [] };
  let maxFitDelta = 0;
  let expected;
  for (const [label, infer] of [['baseline', baseline], ['optimized', inferTextStyles], ['optimized', inferTextStyles], ['baseline', baseline]]) {
    const startedAt = performance.now();
    const results = await infer(input);
    runs[label].push(performance.now() - startedAt);
    assert.equal(results.length, fixture.blocks.length);
    if (!expected) expected = results;
    for (let index = 0; index < results.length; index++) {
      assert.deepEqual(results[index].declarations, expected[index].declarations);
      assert.equal(results[index].text, expected[index].text);
      for (const key of Object.keys(expected[index].fit)) {
        const delta = Math.abs(results[index].fit[key] - expected[index].fit[key]);
        maxFitDelta = Math.max(maxFitDelta, delta);
        assert.ok(delta < 1e-6, `${results[index].id}: ${key} changed by ${delta}`);
      }
    }
  }
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const baselineMs = average(runs.baseline);
  const optimizedMs = average(runs.optimized);
  console.log(JSON.stringify({ blocks: fixture.blocks.length, baselineMs, optimizedMs,
    speedup: baselineMs / optimizedMs, equivalentDeclarations: true, maxFitDelta, node: process.version }, null, 2));
} finally { await shutdownBrowserPool(); await rm(root, { recursive: true, force: true }); }
