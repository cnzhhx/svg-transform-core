import assert from "node:assert/strict";
import { it } from "node:test";
import { detectBrowserBinary, evaluatePage, launchEdge, shutdownBrowserPool } from "../../src/core/cdp.js";

// This needs an installed Chromium and runs separately from the unit suite.
// A mocked protocol cannot prove that a timed-out script actually stopped.
it("recovers the browser after timing out JavaScript that resumes after an await", { skip: !detectBrowserBinary() }, async (t) => {
  t.after(shutdownBrowserPool);
  const browser = await launchEdge();
  const options = { port: browser.port, url: "about:blank", readyExpression: "true", viewportWidth: 100, viewportHeight: 100, maxRetries: 0 };
  const startedAt = Date.now();
  await assert.rejects(evaluatePage({
    ...options,
    evaluateTimeoutMs: 100,
    expression: "(async () => { await Promise.resolve(); while (true) {} })()",
  }), /Timed out after 100ms/);
  assert.ok(Date.now() - startedAt < 3000, "cleanup must not spend another full CDP timeout waiting for the busy renderer");
  assert.equal(await evaluatePage({ ...options, evaluateTimeoutMs: 1000, expression: "6 * 7" }), 42);
  await browser.close();
});
