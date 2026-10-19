import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, type TestContext } from "node:test";
import { createAgentProcessCleanup } from "../../src/pipeline/agent-runtime/process-lifecycle.js";
import { createOpencodeRuntime } from "../../src/pipeline/agent-runtime/opencode-runtime.js";
import type { ModelProviderConfig } from "../../src/config/model-provider.js";

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    // A reparented zombie has exited and holds no model/browser memory.
    if (process.platform === "linux") {
      return !readFileSync(`/proc/${pid}/stat`, "utf8").match(/\) Z /);
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function waitForExit(pid: number) {
  const deadline = Date.now() + 2000;
  while (isRunning(pid) && Date.now() < deadline) await delay(20);
  assert.equal(isRunning(pid), false, `process ${pid} must have exited`);
}

function fixture(t: TestContext, source: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agent-process-test-"));
  const executable = path.join(dir, "opencode.cjs");
  writeFileSync(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const previous = process.env.OPENCODE_CLI_PATH;
  process.env.OPENCODE_CLI_PATH = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENCODE_CLI_PATH;
    else process.env.OPENCODE_CLI_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const config: ModelProviderConfig = {
    apiKey: "test", baseURL: "http://127.0.0.1/unused", headers: {},
    id: "test", model: "test", provider: "test", providerLabel: "test",
    reasoningEffort: "low", runtime: "opencode", runtimeTrace: false,
    runtimeTraceSampleChars: 0, thinking: false, wireApi: "responses",
  };
  return { dir, thread: createOpencodeRuntime(config).startThread({ workingDirectory: dir }) };
}

describe("agent process lifecycle", { skip: process.platform === "win32" }, () => {
  it("kills a tool that ignores SIGTERM even after the model parent has exited", async (t) => {
    const nestedSource = 'process.on("SIGTERM",()=>{});console.log(process.pid);setInterval(()=>{},1000)';
    const parent = spawn(process.execPath, ["-e", `
      const {spawn}=require("node:child_process");
      process.on("SIGTERM",()=>process.exit(0));
      spawn(process.execPath,["-e",${JSON.stringify(nestedSource)}],{stdio:["ignore","inherit","inherit"]});
      setInterval(()=>{},1000);
    `], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { try { process.kill(-parent.pid!, "SIGKILL"); } catch {} });
    const exited = once(parent, "exit");
    const [data] = await once(parent.stdout!, "data");
    const nestedPid = Number(String(data).trim());
    assert.ok(nestedPid > 0);
    const stop = createAgentProcessCleanup(parent, exited, 150);
    const first = stop();
    assert.equal(stop(), first, "cleanup must be idempotent");
    await first;
    await waitForExit(nestedPid);
    assert.equal(parent.exitCode, 0);
  });

  it("escalates when the model itself ignores SIGTERM", async (t) => {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
    const exited = once(child, "exit");
    await once(child.stdout!, "data");
    await createAgentProcessCleanup(child, exited, 100)();
    assert.equal(child.signalCode, "SIGKILL");
  });

  it("waits for normal exit after stdout closes without converting success into cancellation", async (t) => {
    const { thread } = fixture(t, `
      process.stdout.write(JSON.stringify({type:"text",part:{text:"completed"}})+"\\n");
      process.stdout.end();
      setTimeout(()=>process.exit(0),100);
    `);
    const result = await thread.run("test");
    assert.equal(result.finalResponse, "completed");
    assert.equal(result.metrics?.providerTelemetry?.exitCode, 0);
    assert.equal(result.metrics?.providerTelemetry?.exitSignal, null);
  });

  it("cleans up the process and temporary config when the event consumer stops early", async (t) => {
    const { dir, thread } = fixture(t, `
      require("node:fs").writeFileSync("process.json",JSON.stringify({pid:process.pid,config:process.env.OPENCODE_CONFIG}));
      process.stdout.write(JSON.stringify({type:"text",sessionID:"test-session",part:{text:"started"}})+"\\n");
      setInterval(()=>{},1000);
    `);
    const result = await thread.runStreamed("test");
    for await (const event of result.events) {
      if (event.type === "thread.started") break;
    }
    const { pid, config } = JSON.parse(readFileSync(path.join(dir, "process.json"), "utf8"));
    await waitForExit(pid);
    assert.equal(existsSync(path.dirname(config)), false);
  });

  it("closes inherited output pipes when a model exits before its tool", { timeout: 10000 }, async (t) => {
    const { dir, thread } = fixture(t, `
      const tool=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});
      require("node:fs").writeFileSync("tool-pid",String(tool.pid));
      process.stdout.write(JSON.stringify({type:"text",part:{text:"completed"}})+"\\n",()=>process.exit(0));
    `);
    const result = await thread.run("test");
    assert.equal(result.finalResponse, "completed");
    await waitForExit(Number(readFileSync(path.join(dir, "tool-pid"), "utf8")));
  });

  it("cancels a live model call and waits for it to exit before rejecting", async (t) => {
    const { dir, thread } = fixture(t, `
      require("node:fs").writeFileSync("pid",String(process.pid));
      process.stdout.write(JSON.stringify({type:"text",sessionID:"test-session",part:{text:"started"}})+"\\n");
      setInterval(()=>{},1000);
    `);
    const controller = new AbortController();
    const streamed = await thread.runStreamed("test", { signal: controller.signal });
    let failure = "";
    for await (const event of streamed.events) {
      if (event.type === "thread.started") controller.abort("session-failed");
      if (event.type === "turn.failed") failure = event.error.message;
    }
    assert.match(failure, /aborted: session-failed/);
    await waitForExit(Number(readFileSync(path.join(dir, "pid"), "utf8")));
  });
});
