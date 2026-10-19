import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { TestContext } from 'node:test';

// Advance the fixed retry delay without model calls or real ten-second waits.
export async function fastModelRetries<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = run();
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    for (let ticks = 0; !settled; ticks++) {
      assert.ok(ticks < 10000, 'model operation must finish within its retry budget');
      await setImmediate();
      t.mock.timers.tick(10000);
    }
    return await pending;
  } finally {
    t.mock.timers.reset();
  }
}
