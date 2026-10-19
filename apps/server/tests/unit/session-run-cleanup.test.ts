import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { runWithLimit } from "../../src/pipeline/agent-runner/queue/concurrency.js";
import { createAgentRunQueue } from "../../src/pipeline/agent-runner/queue/run-queue.js";
import { sessionStore } from "../../src/session-store.js";
import {
  assertAgentProcessCanStart,
  registerAgentProcess,
  withAgentProcessScope,
} from "../../src/pipeline/agent-runtime/process-lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("session failure cleanup", () => {
  it("aborts siblings, stops claiming modules, waits for cleanup and preserves the original error", async () => {
    const controller = new AbortController();
    const started = deferred();
    const cleanup = deferred();
    const canceled = deferred();
    const error = new Error("CDP timeout");
    const claimed: number[] = [];
    let settled = false;
    const run = runWithLimit({
      items: [0, 1, 2, 3], limit: 2, signal: controller.signal, cancelOnError: (error) => controller.abort(error),
      worker: async (item) => {
        claimed.push(item);
        if (item === 0) { await started.promise; throw error; }
        controller.signal.addEventListener("abort", canceled.resolve, { once: true });
        started.resolve();
        await canceled.promise;
        await cleanup.promise;
        throw new Error("sibling cleanup error");
      },
    });
    const checked = assert.rejects(run, (reason) => reason === error).then(() => { settled = true; });
    await canceled.promise;
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(controller.signal.reason, error);
    assert.deepEqual(claimed, [0, 1]);
    cleanup.resolve();
    await checked;
    assert.deepEqual(claimed, [0, 1]);
  });

  it("keeps the session slot until outstanding process cleanup finishes", async (t) => {
    t.mock.method(sessionStore, "list", () => []);
    t.mock.method(sessionStore, "markQueued", () => {});
    t.mock.method(sessionStore, "flushSessionWrites", async () => {});
    t.mock.method(sessionStore, "get", (id: string) => ({ id, pendingUserMessages: [], status: "running" }) as unknown as ReturnType<typeof sessionStore.get>);
    t.mock.method(sessionStore, "updateQueuePosition", () => {});
    t.mock.method(sessionStore, "failPipeline", () => {});
    t.mock.method(console, "error", () => {});
    const stopping = deferred();
    const stopped = deferred();
    const nextStarted = deferred();
    const started: string[] = [];
    const queue = createAgentRunQueue({
      maxConcurrentAgents: 1,
      runSession: (id, controller) => withAgentProcessScope(controller, async () => {
        started.push(id);
        if (id === "second") { nextStarted.resolve(); return; }
        registerAgentProcess(async () => { stopping.resolve(); await stopped.promise; });
        throw new Error("first session failed");
      }),
    });
    await queue.enqueueSession("first");
    await queue.enqueueSession("second");
    await stopping.promise;
    await setImmediate();
    assert.deepEqual(started, ["first"]);
    stopped.resolve();
    await nextStarted.promise;
    assert.deepEqual(started, ["first", "second"]);
  });

  it("drains active workers on user cancellation without starting queued modules", async () => {
    const controller = new AbortController();
    const cleanup = deferred();
    const claimed: number[] = [];
    let settled = false;
    const run = runWithLimit({
      items: [0, 1, 2], limit: 2, signal: controller.signal, cancelOnError: (error) => controller.abort(error),
      worker: async (item) => { claimed.push(item); await cleanup.promise; },
    });
    const checked = assert.rejects(run, { name: "AbortError" }).then(() => { settled = true; });
    controller.abort("deleted-by-user");
    await setImmediate();
    assert.equal(settled, false);
    cleanup.resolve();
    await checked;
    assert.deepEqual(claimed, [0, 1]);
  });

  it("preserves ordered results on success and never starts work if already canceled", async () => {
    assert.deepEqual(await runWithLimit({
      items: [1, 2, 3], limit: 2, signal: new AbortController().signal,
      worker: async (item) => item * 2,
    }), [2, 4, 6]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runWithLimit({
      items: [1], limit: 2, signal: controller.signal, cancelOnError: (error) => controller.abort(error),
      worker: async () => assert.fail("must not start"),
    }), { name: "AbortError" });
  });

  it("rejects late process launches from async work left behind by a closed session", async () => {
    const resume = deferred();
    let lateLaunch!: Promise<void>;
    await withAgentProcessScope(new AbortController(), async () => {
      lateLaunch = resume.promise.then(() => assertAgentProcessCanStart());
    });
    const checked = assert.rejects(lateLaunch, { name: "AbortError" });
    resume.resolve();
    await checked;
  });
});
