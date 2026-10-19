import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type ProcessCleanup = () => Promise<void>;
type ProcessScope = {
  closing: boolean;
  controller: AbortController;
  cleanups: Set<ProcessCleanup>;
};
const processScopes = new AsyncLocalStorage<ProcessScope>();

export const getAgentProcessSignal = () => processScopes.getStore()?.controller.signal;

// A session owns every model process created in its async context, including
// vision calls whose caller may already have rejected or timed out.
export async function withAgentProcessScope<T>(
  controller: AbortController,
  run: () => Promise<T>,
): Promise<T> {
  const scope: ProcessScope = { closing: false, controller, cleanups: new Set() };
  return processScopes.run(scope, async () => {
    let runFailed = false;
    let runError: unknown;
    let value!: T;
    try {
      value = await run();
    } catch (error) {
      runFailed = true;
      runError = error;
      controller.abort(error);
    }
    scope.closing = true;
    if (scope.cleanups.size) controller.abort("session-process-cleanup");
    const results = await Promise.allSettled([...scope.cleanups].map((stop) => stop()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      if (!runFailed) throw failure.reason;
      console.error("[agent-process] cleanup failed after session failure:", failure.reason);
    }
    if (runFailed) throw runError;
    return value;
  });
}

export function assertAgentProcessCanStart() {
  const scope = processScopes.getStore();
  if (!scope || (!scope.closing && !scope.controller.signal.aborted)) return;
  const error = new Error("Session aborted; refusing to start another agent process");
  error.name = "AbortError";
  throw error;
}

export function registerAgentProcess(stop: ProcessCleanup) {
  const scope = processScopes.getStore();
  scope?.cleanups.add(stop);
  return () => { scope?.cleanups.delete(stop); };
}

// POSIX callers must spawn with detached:true: the resulting process group is
// exclusive to this model call and includes its MCP tools and browser children.
export function createAgentProcessCleanup(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs = 5000,
): ProcessCleanup {
  let stopping: Promise<void> | undefined;
  const stop = async () => {
    const pid = child.pid;
    if (pid === undefined) { await exited; return; }
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          execFile("taskkill", ["/pid", String(pid), "/T", "/F"], (error) => {
            if (error && child.exitCode === null && child.signalCode === null) reject(error);
            else resolve();
          });
        });
      }
      await exited;
      return;
    }
    const signalGroup = async (signal: NodeJS.Signals): Promise<boolean> => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        // macOS can report EPERM when only reparented zombies remain.
        if ((error as NodeJS.ErrnoException).code === "EPERM" && !await hasRunningMembers()) return false;
        throw error;
      }
    };
    const hasRunningMembers = async (): Promise<boolean> => {
      const output = await new Promise<string>((resolve, reject) => {
        execFile("ps", ["-eo", "pgid=,stat="], (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
      // Linux can retain adopted zombies until PID 1 reaps them. They have
      // already exited and hold no model/browser resources.
      return output.split("\n").some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && state && !/^[ZX]/.test(state);
      });
    };
    if (await hasRunningMembers() && await signalGroup("SIGTERM")) {
      const deadline = Date.now() + graceMs;
      while (await hasRunningMembers() && Date.now() < deadline) await delay(50);
      // The parent may have exited already, while a tool still owns the group.
      // Escalation must therefore not depend on child.exitCode.
      if (await hasRunningMembers()) {
        await signalGroup("SIGKILL");
        // Do not release the session slot merely because SIGKILL was sent.
        while (await hasRunningMembers()) await delay(50);
      }
    }
    await exited;
  };
  return () => (stopping ??= stop());
}
