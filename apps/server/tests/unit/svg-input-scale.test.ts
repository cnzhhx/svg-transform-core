import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSvgInput } from '../../src/core/svg-parse.js';

const svg = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"/>`;
const budgetError = /SVG exceeds the rendered dimension or pixel budget/;

test('750 by 7130 long page fits the pixel budget at 1x and 2x', () => {
  for (const scale of [1, 2]) {
    assert.deepEqual(validateSvgInput(svg(750, 7130), scale), {
      width: 750 * scale, height: 7130 * scale, nodeCount: 1,
    });
  }
});

test('rendered pixel budget accepts its boundary and rejects excess at 2x', () => {
  assert.equal(validateSvgInput(svg(1000, 10000), 2).height, 20000);
  assert.throws(() => validateSvgInput(svg(1000, 10001), 2), budgetError);
});

test('rendered dimension limit applies once to both axes at 2x', () => {
  for (const [width, height] of [[16384, 1], [1, 16384]]) {
    assert.doesNotThrow(() => validateSvgInput(svg(width!, height!), 2));
    assert.throws(() => validateSvgInput(svg(width! + 1, height! + 1), 2), budgetError);
  }
});

test('1x still rejects oversized dimensions and pixel counts', () => {
  assert.throws(() => validateSvgInput(svg(1, 32769)), budgetError);
  assert.throws(() => validateSvgInput(svg(10000, 4001)), budgetError);
});
