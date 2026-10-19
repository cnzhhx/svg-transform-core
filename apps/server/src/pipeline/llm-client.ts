import {
  resolveModelConfigForRole,
} from "../config/model-provider.js";
import type {
  ModelConfigRole,
  ModelProviderConfig,
} from "../config/model-provider.js";
import { getAgentRuntime } from "./agent-runtime/index.js";
import { AgentRuntimeError } from "./agent-runtime/errors.js";
import type {
  AgentInput,
  AgentRunStreamedResult,
  AgentThread,
  AgentThreadEvent,
  AgentTurnMetrics,
  AgentTurn,
  ThreadOptions,
} from "./agent-runtime/index.js";
import { AGENT_REASONING_EFFORTS } from "../config/agent-reasoning.js";
import {
  getModelUsageContextModel,
  recordModelRetry,
  recordModelUsage,
} from "./model-usage.js";
import { ModelResponseError, runWithModelRetries, streamWithModelRetries } from "./model-retry.js";

const createThreadOptions = (
  modelConfig: Pick<ModelProviderConfig, "model" | "reasoningEffort">,
): ThreadOptions => ({
  // 不走人工审批流；代理在执行命令或改文件时不会停下来等待确认。
  approvalPolicy: "never",
  // 本轮线程默认使用的模型名称。
  model: modelConfig.model,
  // 控制模型推理强度；xhigh 是这版 SDK 暴露的最高档，速度更慢、成本更高，但复杂任务更稳。
  modelReasoningEffort: modelConfig.reasoningEffort,
  // 允许代理在运行中访问网络资源。
  networkAccessEnabled: true,
  // 给予代理高权限沙箱能力，基本等同于不受限地访问工作目录与执行命令。
  sandboxMode: "danger-full-access",
  // 跳过 Git 仓库信任检查，避免因为目录未被标记为 trusted 而直接拒绝执行。
  skipGitRepoCheck: true,
  // 打开网页搜索能力，代理可以使用内置 web search。
  webSearchEnabled: true,
  // 使用实时搜索，不只读缓存结果。
  webSearchMode: "live",
});

const applyThreadOptionDefaults = (
  modelConfig: ModelProviderConfig,
  options: ThreadOptions,
): ThreadOptions => ({
  ...createThreadOptions(modelConfig),
  ...options,
  model: modelConfig.model,
  modelReasoningEffort:
    options.modelReasoningEffort ?? modelConfig.reasoningEffort,
});

const trackThreadUsage = ({
  modelConfig,
  modelRole,
  source,
  thread,
  restartThread,
}: {
  modelConfig: ModelProviderConfig;
  modelRole: ModelConfigRole;
  source?: string;
  thread: AgentThread;
  restartThread: () => AgentThread;
}): AgentThread => {
  let currentThread = thread;
  const onRetry = (retry: Parameters<typeof recordModelRetry>[0]) =>
    recordModelRetry(retry, { source });
  return {
    get id() {
      return currentThread.id;
    },

    async run(
      input: AgentInput,
      turnOptions?: { signal?: AbortSignal },
    ): Promise<AgentTurn> {
      return runWithModelRetries({
        signal: turnOptions?.signal,
        onRetry,
        run: async (retry) => {
          if (retry?.freshThread) currentThread = restartThread();
          const turn = await currentThread.run(input, turnOptions);
          recordModelUsage({
            inputKind: getInputKind(input),
            metrics: turn.metrics,
            modelConfig,
            modelRole,
            source,
            threadId: currentThread.id,
            usage: turn.usage,
          });
          if (!turn.finalResponse.trim()) throw new ModelResponseError('Model returned an empty response');
          return turn;
        },
      });
    },

    async runStreamed(
      input: AgentInput,
      turnOptions?: { signal?: AbortSignal },
    ): Promise<AgentRunStreamedResult> {
      return {
        events: (async function* (): AsyncGenerator<AgentThreadEvent> {
          try {
            yield* streamWithModelRetries({
              signal: turnOptions?.signal,
              onRetry,
              run: async function* (retry): AsyncGenerator<AgentThreadEvent> {
                if (retry?.freshThread) currentThread = restartThread();
                const streamed = await currentThread.runStreamed(input, turnOptions);
                let metrics: AgentTurnMetrics | undefined;
                let completed = false;
                let hasOutput = false;
                for await (const event of streamed.events) {
                  if (event.type === 'turn.failed') throw new AgentRuntimeError(event.error);
                  if (event.type === 'turn.metrics') metrics = event.metrics;
                  if (event.type === 'item.completed' && (
                    event.item.type === 'agent_message' && event.item.text.trim() ||
                    event.item.type === 'command_execution' || event.item.type === 'file_change' ||
                    event.item.type === 'mcp_tool_call'
                  )) hasOutput = true;
                  if (event.type === 'turn.completed') {
                    recordModelUsage({
                      inputKind: getInputKind(input), metrics, modelConfig, modelRole,
                      source, threadId: currentThread.id, usage: event.usage,
                    });
                    if (!hasOutput) throw new ModelResponseError('Model returned an empty response');
                    completed = true;
                  }
                  yield event;
                }
                if (!completed) throw new AgentRuntimeError({
                  message: 'Model stream ended without completing', code: 'MODEL_STREAM_INCOMPLETE',
                });
              },
            });
          } catch (error) {
            if (!(error instanceof AgentRuntimeError)) throw error;
            yield { type: 'turn.failed', error: {
              name: error.name, message: error.message, code: error.code, statusCode: error.statusCode,
            } };
          }
        })(),
      };
    },
  };
};

const getInputKind = (input: AgentInput) =>
  Array.isArray(input) && input.some((item) => item.type === "local_image")
    ? "vision"
    : "text";

const startAgentThread = (
  options: ThreadOptions = {},
  input: {
    modelRole?: ModelConfigRole;
    source?: string;
  } = {},
) => {
  const modelRole = input.modelRole ?? "text";
  const modelConfig = resolveModelConfigForRole(
    modelRole,
    getModelUsageContextModel(),
  );
  const runtime = getAgentRuntime(modelConfig);
  return trackThreadUsage({
    modelConfig,
    modelRole,
    source: input.source,
    thread: runtime.startThread(
      applyThreadOptionDefaults(modelConfig, options),
    ),
    restartThread: () => runtime.startThread(applyThreadOptionDefaults(modelConfig, options)),
  });
};

const resumeAgentThread = (
  id: string,
  options: ThreadOptions = {},
  input: {
    modelRole?: ModelConfigRole;
    source?: string;
  } = {},
) => {
  const modelRole = input.modelRole ?? "text";
  const modelConfig = resolveModelConfigForRole(
    modelRole,
    getModelUsageContextModel(),
  );
  const runtime = getAgentRuntime(modelConfig);
  return trackThreadUsage({
    modelConfig,
    modelRole,
    source: input.source,
    thread: runtime.resumeThread(
      id,
      applyThreadOptionDefaults(modelConfig, options),
    ),
    restartThread: () => runtime.startThread(applyThreadOptionDefaults(modelConfig, options)),
  });
};

const runVisionLlm = async ({
  imagePath,
  prompt,
  runtimeTraceDir,
  runtimeTraceLabel,
  signal,
}: {
  imagePath: string;
  prompt: string;
  runtimeTraceDir?: string;
  runtimeTraceLabel?: string;
  signal?: AbortSignal;
}): Promise<string> => {
  const thread = startAgentThread(
    {
      modelReasoningEffort: AGENT_REASONING_EFFORTS.vision,
      runtimeTraceDir,
      runtimeTraceLabel,
    },
    { modelRole: "vision" },
  );
  const turn = await thread.run(
    [
      { type: "text", text: prompt },
      { type: "local_image", path: imagePath },
    ],
    { signal },
  );
  return turn.finalResponse ?? "";
};

export {
  resumeAgentThread,
  runVisionLlm,
  startAgentThread,
};
