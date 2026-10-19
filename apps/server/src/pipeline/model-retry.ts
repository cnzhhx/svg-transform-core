import { AsyncLocalStorage } from 'node:async_hooks';
import timers from 'node:timers/promises';
import { AgentRuntimeError } from './agent-runtime/errors.js';
import { getAgentProcessSignal } from './agent-runtime/process-lifecycle.js';

export const DEFAULT_MODEL_RETRIES = 5;
const MODEL_RETRY_DELAY_MS = 10000;

// Planning/validation and streamed module turns can own the retry budget.
// Calls through llm-client inside that operation must remain single attempts.
const retryScope = new AsyncLocalStorage<boolean>();

export class ModelResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelResponseError';
  }
}

type ModelError = Error & { code?: string; statusCode?: number; status?: number };

export const needsFreshAgentThread = (error: unknown) => error instanceof Error &&
  /invalid_encrypted_content|encrypted content.*(?:verified|decrypted|parsed)/i.test(
    `${(error as ModelError).code ?? ''} ${error.message}`,
  );

export const isRetryableModelError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const errors: ModelError[] = [];
  let cause: unknown = error;
  while (cause instanceof Error && !errors.includes(cause)) {
    errors.push(cause);
    cause = cause.cause;
  }
  const text = errors.map(entry => `${entry.name} ${entry.code ?? ''} ${entry.message}`).join(' ');
  if (/AbortError|\baborted\b|module-timeout|user-guidance-interrupt/i.test(text)) return false;
  if (needsFreshAgentThread(error)) return true;
  if (/invalid[_ -]?(?:api[_ -]?key|request|parameter)|incorrect api key|unauthori[sz]ed|authenticat|permission denied|insufficient[_ -]quota|unknown model|model.*not found|unsupported model|(?:missing|invalid|unsupported).*config|ENOENT|EACCES|ENOSPC/i.test(text)) return false;
  if (error instanceof ModelResponseError) return true;
  const status = errors.map(entry => entry.statusCode ?? entry.status).find(value => value !== undefined) ??
    Number(text.match(/(?:HTTP|status(?:Code)?)[\s:=]*(\d{3})\b/i)?.[1] ?? 0);
  if (status) return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
  // Runtime failures without HTTP metadata are still model failures. Local and
  // permanent errors have already been excluded above.
  if (error instanceof AgentRuntimeError) return true;
  return /fetch failed|network|socket|connection (?:closed|reset|refused|failed)|stream (?:closed|ended|reset)|\bEOF\b|ECONN|ENET|EHOST|ETIMEDOUT|EAI_AGAIN|UND_ERR|certificate|\bTLS\b|\bSSL\b|CERT_|ERR_TLS|timed?\s*out|timeout|rate[_ -]?limit|overloaded|temporar(?:y|ily)|service unavailable|internal server error|opencode cli exited|MODEL_STREAM_INCOMPLETE/i.test(text);
};

export type ModelRetry = {
  number: number;
  maxRetries: number;
  delayMs: number;
  freshThread: boolean;
  error: Error;
};

type RetryOptions = {
  maxRetries?: number;
  onRetry?: (retry: ModelRetry) => void | Promise<void>;
  signal?: AbortSignal;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const normalizeModelRetries = (value = DEFAULT_MODEL_RETRIES) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : DEFAULT_MODEL_RETRIES;

export async function* streamWithModelRetries<T>({ run, onRetry, signal: callerSignal, maxRetries,
  wait = (ms, abortSignal) => timers.setTimeout(ms, undefined, { signal: abortSignal }),
}: RetryOptions & {
  run: (retry?: ModelRetry) => AsyncIterable<T>;
}): AsyncGenerator<T> {
  if (retryScope.getStore()) {
    yield* run();
    return;
  }
  const sessionSignal = getAgentProcessSignal();
  const signal = sessionSignal && callerSignal
    ? AbortSignal.any([sessionSignal, callerSignal]) : sessionSignal ?? callerSignal;
  const checkAborted = () => {
    if (!signal?.aborted) return;
    const error = new Error(String(signal.reason ?? 'aborted'));
    error.name = 'AbortError';
    throw error;
  };
  const limit = normalizeModelRetries(maxRetries);
  let retry: ModelRetry | undefined;
  for (let attempt = 0; ; attempt += 1) {
    checkAborted();
    try {
      const iterator = retryScope.run(true, () => run(retry)[Symbol.asyncIterator]());
      let finished = false;
      try {
        for (;;) {
          const next = await retryScope.run(true, () => iterator.next());
          if (next.done) { finished = true; break; }
          yield next.value;
        }
      } finally {
        // Fully drain/close the failed process before another attempt can start.
        if (!finished) await retryScope.run(true, () => iterator.return?.());
      }
      return;
    } catch (error) {
      checkAborted();
      if (attempt >= limit || !isRetryableModelError(error)) throw error;
      retry = { number: attempt + 1, maxRetries: limit,
        delayMs: MODEL_RETRY_DELAY_MS,
        freshThread: needsFreshAgentThread(error), error: error as Error };
      await onRetry?.(retry);
      checkAborted();
      await wait(retry.delayMs, signal);
    }
  }
}

export async function runWithModelRetries<T>({ run, ...options }: RetryOptions & {
  run: (retry?: ModelRetry) => Promise<T>;
}): Promise<T> {
  let result!: T;
  for await (const value of streamWithModelRetries({
    ...options,
    run: async function* (retry) { yield await run(retry); },
  })) result = value;
  return result;
}
