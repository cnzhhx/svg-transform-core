import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ModelConfigRole,
  ModelProviderConfig,
} from "../config/model-provider.js";
import { sessionStore } from "../session-store.js";
import type { AgentTurnMetrics, Usage } from "./agent-runtime/index.js";
import type { ModelRetry } from "./model-retry.js";

type ModelUsageContext = {
  model?: string;
  sessionId?: string;
  source?: string;
};

type ModelUsageRecord = {
  cachedInputTokens: number;
  createdAt: number;
  id: string;
  inputKind?: "text" | "vision";
  inputTokens: number;
  modelConfigId: string;
  model: string;
  modelRole?: ModelConfigRole;
  metrics?: AgentTurnMetrics;
  outputTokens: number;
  provider: string;
  runtime: string;
  source?: string;
  threadId?: string | null;
  tokensUsed: number;
  uncachedInputTokens: number;
};

const usageContext = new AsyncLocalStorage<ModelUsageContext>();

const toTokenNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

const normalizeUsage = (usage: Usage | null | undefined) => {
  const inputTokens = toTokenNumber(usage?.input_tokens);
  const cachedInputTokens = toTokenNumber(usage?.cached_input_tokens);
  const outputTokens = toTokenNumber(usage?.output_tokens);
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    tokensUsed: inputTokens + outputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
  };
};

const withModelUsageContext = <T>(
  context: ModelUsageContext,
  callback: () => T,
) => usageContext.run({ ...usageContext.getStore(), ...context }, callback);

const getModelUsageContextModel = () => usageContext.getStore()?.model;

const recordModelRetry = (retry: ModelRetry, input: {
  sessionId?: string;
  moduleId?: string;
  source?: string;
} = {}) => {
  const context = usageContext.getStore();
  const sessionId = input.sessionId ?? context?.sessionId;
  const source = input.source ?? context?.source ?? 'model';
  const label = input.moduleId ? `${source}:${input.moduleId}` : source;
  const message = `[${label}] retry ${retry.number}/${retry.maxRetries} in ${retry.delayMs}ms (${retry.freshThread ? 'new thread' : 'same thread'}): ${retry.error.message}`;
  if (!sessionId || !sessionStore.get(sessionId)) {
    console.warn(message);
    return;
  }
  sessionStore.addLog(sessionId, message);
  sessionStore.addMessage(sessionId, {
    id: `model-retry-${randomUUID()}`,
    kind: 'event',
    moduleId: input.moduleId,
    role: 'system',
    text: `模型调用中断，${retry.delayMs / 1000} 秒后重试 ${retry.number}/${retry.maxRetries}${retry.freshThread ? '（重建会话，保留已有文件）' : ''}。`,
  });
};

const recordModelUsage = ({
  inputKind,
  metrics,
  modelConfig,
  modelRole,
  source,
  threadId,
  usage,
}: {
  inputKind?: "text" | "vision";
  metrics?: AgentTurnMetrics;
  modelConfig: Pick<
    ModelProviderConfig,
    "id" | "model" | "providerLabel" | "runtime"
  >;
  modelRole?: ModelConfigRole;
  source?: string;
  threadId?: string | null;
  usage: Usage | null | undefined;
}) => {
  const context = usageContext.getStore();
  const sessionId = context?.sessionId;
  if (!sessionId || !usage) return;

  const normalized = normalizeUsage(usage);
  if (normalized.inputTokens <= 0 && normalized.outputTokens <= 0) return;

  const session = sessionStore.get(sessionId);
  if (!session) return;

  const record: ModelUsageRecord = {
    ...normalized,
    createdAt: Date.now(),
    id: randomUUID(),
    inputKind,
    metrics,
    model: modelConfig.model,
    modelConfigId: modelConfig.id,
    modelRole,
    provider: modelConfig.providerLabel,
    runtime: modelConfig.runtime,
    source: source ?? context.source,
    threadId,
  };
  const previousRecords = Array.isArray(session.result.modelUsageRecords)
    ? session.result.modelUsageRecords
    : [];

  sessionStore.update(sessionId, {
    result: {
      ...session.result,
      cachedInputTokens:
        Number(session.result.cachedInputTokens ?? 0) +
        normalized.cachedInputTokens,
      inputTokens:
        Number(session.result.inputTokens ?? 0) + normalized.inputTokens,
      modelUsageRecords: [...previousRecords, record],
      outputTokens:
        Number(session.result.outputTokens ?? 0) + normalized.outputTokens,
      tokensUsed:
        Number(session.result.tokensUsed ?? 0) + normalized.tokensUsed,
      uncachedInputTokens:
        Number(session.result.uncachedInputTokens ?? 0) +
        normalized.uncachedInputTokens,
    },
  });
};

export {
  getModelUsageContextModel,
  recordModelRetry,
  recordModelUsage,
  withModelUsageContext,
};
