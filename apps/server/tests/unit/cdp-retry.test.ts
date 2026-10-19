import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { capturePage, evaluatePage, withCdpSignal, withCdpOperationSlot } from "../../src/core/cdp.js";
import timers, { setTimeout as delay } from 'node:timers/promises';

type Command = { id: number; method: string; params: Record<string, unknown> };
type Reply = { result?: unknown; error?: { message: string } };

// Exercise the real HTTP target lifecycle, WebSocket transport and timeout path
// without launching Chrome or waiting for the production 120-second timeout.
async function browserFixture(
  t: TestContext,
  respond: (command: Command, target: number) => Reply | undefined,
) {
  const targets: number[] = [];
  const closed: number[] = [];
  const commands: { target: number; method: string }[] = [];
  const sockets = new Map<number, WebSocket>();
  let port = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/json/new?")) {
      const target = targets.length + 1;
      targets.push(target);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        id: String(target),
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${target}`,
      }));
    } else if (req.url?.startsWith("/json/close/")) {
      const target = Number(req.url.split("/").at(-1));
      closed.push(target);
      sockets.get(target)?.close();
      res.end("Target is closing");
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket, req) => {
    const target = Number(req.url?.slice(1));
    sockets.set(target, socket);
    socket.on("message", (data) => {
      const command = JSON.parse(String(data)) as Command;
      commands.push({ target, method: command.method });
      const reply = respond(command, target);
      if (reply) socket.send(JSON.stringify({ id: command.id, ...reply }));
    });
  });
  const previousTimeout = process.env.CDP_SEND_TIMEOUT_MS;
  process.env.CDP_SEND_TIMEOUT_MS = "50";
  t.after(async () => {
    if (previousTimeout === undefined) delete process.env.CDP_SEND_TIMEOUT_MS;
    else process.env.CDP_SEND_TIMEOUT_MS = previousTimeout;
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  const options = {
    port,
    url: "http://fixture/preview.html",
    viewportWidth: 100,
    viewportHeight: 100,
    expression: "window.__TEST_RESULT__",
  };
  return { targets, closed, commands, options };
}

const success = (command: Command): Reply => ({
  result: command.method === "Runtime.evaluate"
    ? { result: { value: command.params.expression === "window.__TEST_RESULT__" ? 42 : true } }
    : command.method === "Page.captureScreenshot"
      ? { data: Buffer.from("screenshot").toString("base64") }
      : {},
});

describe("CDP page timeout recovery", () => {
  it('cancels an active evaluation, terminates execution and releases its target', async t => {
    const controller = new AbortController();
    const fixture = await browserFixture(t, command => {
      if (command.params.expression === 'window.__TEST_RESULT__') {
        controller.abort('session-canceled');
        return undefined;
      }
      return success(command);
    });
    await assert.rejects(withCdpSignal(controller.signal, () => evaluatePage(fixture.options)), { name: 'AbortError' });
    assert.deepEqual(fixture.targets, [1]);
    assert.deepEqual(fixture.closed, [1]);
    assert.ok(fixture.commands.some(command => command.method === 'Runtime.terminateExecution'));
  });

  it('cancels queued CDP work without allocating a page', async t => {
    const fixture = await browserFixture(t, success);
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held = withCdpOperationSlot(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    try {
      const waiting = evaluatePage({ ...fixture.options, signal: controller.signal });
      const rejected = assert.rejects(waiting, { name: 'AbortError' });
      controller.abort('queued-cancellation');
      await rejected;
      assert.deepEqual(fixture.targets, []);
    } finally { release(); await held; }
  });

  it('cancels retry backoff without creating another target', async t => {
    const controller = new AbortController();
    const fixture = await browserFixture(t, command => command.params.expression === 'window.__TEST_RESULT__' ? undefined : success(command));
    const pending = evaluatePage({ ...fixture.options, signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    try {
      for (let attempt = 0; attempt < 100 && !fixture.closed.length; attempt++) await delay(5);
      assert.deepEqual(fixture.closed, [1]);
      await delay(25);
      controller.abort('cancel-during-backoff');
      await rejected;
      assert.deepEqual(fixture.targets, [1]);
    } finally { controller.abort('test-cleanup'); await rejected; }
  });

  it('keeps the active operation lease fresh and removes it on release', async t => {
    const lockDir = path.join(os.tmpdir(), 'svg-to-html-cdp-locks');
    let ownedLock = '';
    t.mock.timers.enable({ apis: ['setInterval'] });
    await withCdpOperationSlot(async () => {
      for (const name of await readdir(lockDir)) {
        const file = path.join(lockDir, name);
        if ((await readFile(file, 'utf8').catch(() => '')).startsWith(`${process.pid}\n`)) ownedLock = file;
      }
      assert.ok(ownedLock);
      const before = (await stat(ownedLock)).mtimeMs;
      await delay(5);
      t.mock.timers.tick(60_000);
      for (let attempt = 0; attempt < 20 && (await stat(ownedLock)).mtimeMs <= before; attempt++) await delay(5);
      assert.match(await readFile(ownedLock, 'utf8'), new RegExp(`^${process.pid}\\n`));
      assert.ok((await stat(ownedLock)).mtimeMs > before);
    });
    assert.equal(await stat(ownedLock).then(() => true, () => false), false);
  });

  it("returns a successful result without retrying", async (t) => {
    const fixture = await browserFixture(t, success);
    assert.equal(await evaluatePage(fixture.options), 42);
    assert.deepEqual(fixture.targets, [1]);
    assert.deepEqual(fixture.closed, [1]);
  });

  it("recreates the page after evaluate times out and closes the old target before retry", async (t) => {
    const fixture = await browserFixture(t, (command, target) => {
      if (target === 1 && command.params.expression === "window.__TEST_RESULT__") return undefined;
      if (target === 2) assert.deepEqual(fixture.closed, [1]);
      return success(command);
    });
    assert.equal(await evaluatePage(fixture.options), 42);
    assert.deepEqual(fixture.targets, [1, 2]);
    assert.deepEqual(fixture.closed, [1, 2]);
    assert.equal(fixture.commands.filter((command) => command.method === "Page.navigate").length, 2);
  });

  it("recovers from readiness and screenshot command timeouts", async (t) => {
    const fixture = await browserFixture(t, (command, target) => {
      if (target === 1 && command.method === "Runtime.evaluate") return undefined;
      if (target === 2 && command.method === "Page.captureScreenshot") return undefined;
      return success(command);
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "cdp-retry-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const outputPath = path.join(dir, "capture.png");
    await capturePage({ ...fixture.options, outputPath });
    assert.equal(await readFile(outputPath, "utf8"), "screenshot");
    assert.deepEqual(fixture.targets, [1, 2, 3]);
    assert.deepEqual(fixture.closed, [1, 2, 3]);
  });

  it("lets another session finish while a timed-out operation backs off", { timeout: 30_000 }, async (t) => {
    let notifyBackoff!: () => void;
    let releaseBackoff!: () => void;
    const backingOff = new Promise<void>((resolve) => { notifyBackoff = resolve; });
    const backoffGate = new Promise<void>((resolve) => { releaseBackoff = resolve; });
    const originalDelay = timers.setTimeout;
    const controlledDelay: typeof delay = <T = void>(milliseconds?: number, value?: T, options?: Parameters<typeof delay>[2]) => {
      if (milliseconds !== undefined && milliseconds >= 1000 && milliseconds < 1250) {
        notifyBackoff();
        return backoffGate.then(() => value as T);
      }
      return originalDelay<T>(milliseconds, value, options);
    };
    const mockedDelay = t.mock.method(timers, 'setTimeout', controlledDelay);
    syncBuiltinESMExports();
    t.after(() => { mockedDelay.mock.restore(); syncBuiltinESMExports(); });
    const fixture = await browserFixture(t, (command, target) => {
      if (command.params.expression === "window.__TEST_RESULT__") {
        if (target === 1) return undefined;
        return { result: { result: { value: target } } };
      }
      return success(command);
    });
    const recovering = evaluatePage({ ...fixture.options, signal: t.signal });
    let recoveredResult: unknown;
    try {
      await backingOff;
      // Other test processes share the file lease. Keep this retry paused until
      // the concurrent operation finishes, regardless of host scheduling.
      const concurrentResult = await evaluatePage({ ...fixture.options, signal: t.signal });
      assert.equal(concurrentResult, 2);
      assert.deepEqual(fixture.closed, [1, 2]);
    } finally {
      releaseBackoff();
      recoveredResult = await recovering;
    }
    assert.equal(recoveredResult, 3);
    assert.deepEqual(fixture.closed, [1, 2, 3]);
  });

  it("stops after five retries and preserves the timeout error", async (t) => {
    const fixture = await browserFixture(t, (command) => {
      if (command.params.expression === "window.__TEST_RESULT__") return undefined;
      return success(command);
    });
    await assert.rejects(evaluatePage({ ...fixture.options, evaluateTimeoutMs: 20 }), {
      name: "CdpCommandTimeoutError",
      message: "Timed out after 20ms waiting for CDP command: Runtime.evaluate",
    });
    assert.deepEqual(fixture.targets, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(fixture.closed, [1, 2, 3, 4, 5, 6]);
  });

  it("does not retry page script exceptions or protocol errors", async (t) => {
    const fixture = await browserFixture(t, (command, target) => {
      if (command.params.expression !== "window.__TEST_RESULT__") return success(command);
      return target === 1
        ? { result: { exceptionDetails: { text: "ReferenceError: missingValue" } } }
        : { error: { message: "Invalid parameters" } };
    });
    await assert.rejects(evaluatePage(fixture.options), /Page evaluation failed: ReferenceError/);
    assert.deepEqual(fixture.targets, [1]);
    await assert.rejects(evaluatePage(fixture.options), /Invalid parameters/);
    assert.deepEqual(fixture.targets, [1, 2]);
    assert.deepEqual(fixture.closed, [1, 2]);
  });

  it("interrupts stalled JavaScript and respects a caller's smaller retry budget", async (t) => {
    const fixture = await browserFixture(t, (command) => {
      if (command.params.expression === "window.__TEST_RESULT__") return undefined;
      return success(command);
    });
    await assert.rejects(evaluatePage({ ...fixture.options, evaluateTimeoutMs: 20, maxRetries: 1 }), {
      name: "CdpCommandTimeoutError",
    });
    assert.deepEqual(fixture.targets, [1, 2]);
    assert.deepEqual(fixture.closed, [1, 2]);
    assert.deepEqual(fixture.commands.filter((command) => command.method === "Runtime.terminateExecution").map((command) => command.target), [1, 2]);
  });

  it("can stop after the first timeout without repeating deterministic computation", async (t) => {
    const fixture = await browserFixture(t, (command) => {
      if (command.params.expression === "window.__TEST_RESULT__") return undefined;
      return success(command);
    });
    await assert.rejects(evaluatePage({ ...fixture.options, evaluateTimeoutMs: 20, maxRetries: 0 }), /Timed out/);
    assert.deepEqual(fixture.targets, [1]);
    assert.deepEqual(fixture.closed, [1]);
    assert.equal(await evaluatePage({ ...fixture.options, expression: "1 + 1" }), true);
  });
});
