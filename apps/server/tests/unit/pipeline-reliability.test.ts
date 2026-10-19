import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureSvgViewBox, readSvgDimensions, validateSvgInput } from '../../src/core/svg-parse.js';
import { runWithLimit, Semaphore } from '../../src/pipeline/agent-runner/queue/concurrency.js';
import { buildQualityAssessment, qualityCompletionStatus } from '../../src/pipeline/agent-runner/verify/verify-gates.js';

test('SVG input handles units and exponents and rejects malformed or excessive input', () => {
  assert.deepEqual(readSvgDimensions('<svg width="1e3" height="1in"/>'), { width: 1000, height: 96 });
  assert.deepEqual(readSvgDimensions('<svg width="2.54cm" height="72pt"/>'), { width: 96, height: 96 });
  assert.match(ensureSvgViewBox('<svg width="1in" height="1in"/>'), /viewBox="0 0 96 96"/);
  assert.deepEqual(readSvgDimensions('<!-- <svg width="1" height="1"/> --><svg data-width="7" width="20" height="30"/>'), { width: 20, height: 30 });
  assert.equal(validateSvgInput('<svg viewBox="0 0 10 10"><rect/></svg>').nodeCount, 2);
  for (const svg of ['<html/>', '<svg width="10" height="10"><g></svg>', '<svg width="100%" height="10"/>', '<svg viewBox="0 0 100000 100000"/>', '<!DOCTYPE svg><svg viewBox="0 0 1 1"/>']) {
    assert.throws(() => validateSvgInput(svg));
  }
  assert.throws(() => validateSvgInput('<svg viewBox="0 0 10 10"><g/></svg>', 1, { maxNodes: 1, maxPixels: 1000, maxDimension: 100 }));
});

test('failed workers stop dispatch and drain already started work before rejecting', async () => {
  const events: string[] = [];
  await assert.rejects(runWithLimit({ items: [0, 1, 2], limit: 2, worker: async (item) => {
    events.push(`start:${item}`);
    if (item === 0) throw new Error('first failure');
    await delay(15);
    events.push(`done:${item}`);
  } }), /first failure/);
  assert.deepEqual(events, ['start:0', 'start:1', 'done:1']);
});

test('semaphore rejects invalid limits and canceled waiters do not consume capacity', async () => {
  assert.throws(() => new Semaphore(0));
  const semaphore = new Semaphore(1);
  const controller = new AbortController();
  let release!: () => void;
  const running = semaphore.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await delay(0);
  const waiting = semaphore.run(async () => assert.fail('canceled waiter ran'), controller.signal);
  controller.abort('test');
  await assert.rejects(waiting, { name: 'AbortError' });
  release();
  await running;
  assert.equal(await semaphore.run(async () => 42), 42);
});

test('quality status preserves local failures and supports backward compatible enforcement', () => {
  const quality = buildQualityAssessment({ artifactDir: '', diffPngPath: '', diffRatio: 0.01, renderPngPath: '', svgPngPath: '' }, { failedModuleIds: ['module-1'] });
  assert.equal(quality.status, 'partial');
  assert.equal(qualityCompletionStatus(quality), 'completed');
  assert.equal(qualityCompletionStatus(quality, 'best-effort'), 'best-effort');
  assert.equal(qualityCompletionStatus(quality, 'strict'), 'failed-gate');
});
