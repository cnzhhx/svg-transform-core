import { existsSync } from "node:fs";
import path from "node:path";

import type { AgentThread } from "../../pipeline/agent-runtime/index.js";
import { startAgentThread } from "../../pipeline/llm-client.js";
import { ModelResponseError, runWithModelRetries } from "../../pipeline/model-retry.js";
import { recordModelRetry } from "../../pipeline/model-usage.js";
import { AGENT_REASONING_EFFORTS } from "../../config/agent-reasoning.js";
import {
  getModelPlannerMockResponse,
  getModelPlannerTurnTimeoutMs,
} from "../../config/index.js";
import { writeJsonFile, writeTextFile } from '../file-io.js';
import { normalizeModelPlan } from "./normalize-plan.js";
import type {
  ModelPlannerInput,
  ModelPlannerRequest,
  ModelPlannerResponse,
  ModulePlanValidationIssue,
  ModulePlanValidationResult,
  ModulePlanValidationSummary,
} from "./types.js";
import {
  collectValidationSourceBoxes,
  parseModelPlannerResponse,
  validateModelPlan,
} from "./validate-plan.js";
import type { PlannedModules } from "../svg-vertical-modules/types.js";
import { buildInitialPrompt, buildRetryPrompt } from "../../prompts/planner.js";

const getPlannerTurnTimeoutMs = () => getModelPlannerTurnTimeoutMs();

type ModelPlannerSuccess = {
  attemptCount: number;
  planned: PlannedModules;
  request: ModelPlannerRequest;
  response: ModelPlannerResponse;
  status: "success";
  validation: ModulePlanValidationResult;
};

type ModelPlannerFailure = {
  attemptCount: number;
  failureReason: string;
  request: ModelPlannerRequest;
  response?: unknown;
  status: "failed";
  validation?: ModulePlanValidationResult;
};

type ModelPlannerResult = ModelPlannerFailure | ModelPlannerSuccess;

const toValidationSummary = (
  validation: ModulePlanValidationResult,
): ModulePlanValidationSummary => ({
  errorCount: validation.errorCount,
  errors: validation.errors.slice(0, 20),
  passed: validation.passed,
  warningCount: validation.warningCount,
  warnings: validation.warnings.slice(0, 20),
});

const validationFromIssue = (
  issue: ModulePlanValidationIssue,
): ModulePlanValidationResult => ({
  errorCount: issue.severity === "error" ? 1 : 0,
  errors: issue.severity === "error" ? [issue] : [],
  passed: issue.severity !== "error",
  warningCount: issue.severity === "warning" ? 1 : 0,
  warnings: issue.severity === "warning" ? [issue] : [],
});

const createGeometryHints = (input: ModelPlannerInput) => {
  const sourceBoxes = collectValidationSourceBoxes({
    containerLayout: input.containerLayout,
    viewport: input.viewport,
  });

  return {
    note: "Use these boxes to avoid obvious container cuts, but coordinates may be approximate: choose semantic rough regions and let deterministic post-processing snap pixel boundaries. Do not return one full-page module just to avoid pixel-risk validation issues.",
    sourceBoxes: sourceBoxes.slice(0, 160).map((sourceBox) => ({
      box: sourceBox.box,
      id: sourceBox.id,
      kind: sourceBox.kind,
    })),
  };
};

const createRequest = (
  input: ModelPlannerInput,
): ModelPlannerRequest => ({
  constraints: input.constraints,
  design: input.design,
  geometryHints: createGeometryHints(input),
  mode: input.mode,
});


const writeValidationArtifact = async ({
  moduleDir,
  validation,
}: {
  moduleDir: string;
  validation: ModulePlanValidationResult;
}) =>
  writeJsonFile(path.join(moduleDir, "planner-validation.json"), {
    ...toValidationSummary(validation),
    sourceCoverage: validation.sourceCoverage,
  });

const writeRetryArtifact = async ({
  attempt,
  moduleDir,
  validation,
}: {
  attempt: number;
  moduleDir: string;
  validation: ModulePlanValidationResult;
}) =>
  writeJsonFile(
    path.join(
      moduleDir,
      `planner-retry-${String(attempt).padStart(2, "0")}.json`,
    ),
    {
      errors: validation.errors.slice(0, 20),
      request:
        attempt >= 2
          ? "只返回修正后的 JSON。请使用更稳定、边界更安全、大小更均衡的模块区域。"
          : "只返回修正后的 JSON。保持语义 section 完整，并避开失败的边界。",
      validationFailed: true,
      warnings: validation.warnings.slice(0, 12),
    },
  );

const writeResponseArtifacts = async ({
  moduleDir,
  parsed,
  raw,
}: {
  moduleDir: string;
  parsed: ReturnType<typeof parseModelPlannerResponse>;
  raw: string;
}) => {
  await writeTextFile(path.join(moduleDir, "planner-response.raw.txt"), raw);
  await writeJsonFile(
    path.join(moduleDir, "planner-response.json"),
    parsed.response ?? {
      jsonText: parsed.jsonText,
      parseError: parsed.error?.message ?? "unknown parse error",
    },
  );
};

const runPlannerTurn = async ({
  attempt,
  imagePaths,
  moduleDir,
  prompt,
  thread,
  signal,
}: {
  attempt: number;
  imagePaths?: string[];
  moduleDir: string;
  prompt: string;
  thread: AgentThread;
  signal: AbortSignal;
}) => {
  await writeTextFile(
    path.join(
      moduleDir,
      `planner-prompt-${String(attempt).padStart(2, "0")}.txt`,
    ),
    prompt,
  );
  const mockResponse = getModelPlannerMockResponse();
  signal.throwIfAborted();
  if (mockResponse !== undefined) return mockResponse;

  const turn = imagePaths?.length
    ? await thread.run(
        [
          { type: "text", text: prompt },
          ...imagePaths.map((imagePath) => ({
            type: "local_image" as const,
            path: imagePath,
          })),
        ],
        { signal },
      )
    : await thread.run(prompt, { signal });
  return turn.finalResponse ?? "";
};

const runModelPlanner = async (
  input: ModelPlannerInput,
): Promise<ModelPlannerResult> => {
  const request = createRequest(input);
  await writeJsonFile(
    path.join(input.moduleDir, "planner-request.json"),
    request,
  );

  const createThread = () => startAgentThread(
    {
      additionalDirectories: [
        input.artifactDir,
        path.dirname(input.design.sourceSvgPath),
      ].filter((directory) => existsSync(directory)),
      modelReasoningEffort: AGENT_REASONING_EFFORTS.support,
      networkAccessEnabled: false,
      sandboxMode: "read-only",
      runtimeTraceDir: path.join(
        input.artifactDir,
        "runtime-traces",
        "module-planner",
      ),
      runtimeTraceLabel: "module-planner",
      webSearchEnabled: false,
      webSearchMode: "disabled",
      workingDirectory: process.cwd(),
    },
    { modelRole: "vision" },
  );
  let thread = createThread();

  let latestValidation: ModulePlanValidationResult | undefined;
  let latestResponse: unknown;
  const deadline = AbortSignal.timeout(getPlannerTurnTimeoutMs());
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const historyDir = path.join(input.moduleDir, "planner-history", `${Date.now()}-${process.pid}`);
  let attemptCount = 0;

  try {
    return await runWithModelRetries({
      maxRetries: input.plannerRetries,
      signal,
      onRetry: async (retry) => {
        recordModelRetry(retry, { source: 'module-planner' });
        if (retry.error instanceof ModelResponseError && latestValidation) {
          await writeRetryArtifact({ attempt: retry.number, moduleDir: input.moduleDir, validation: latestValidation });
        }
      },
      run: async (retry): Promise<ModelPlannerSuccess> => {
        signal.throwIfAborted();
        const attempt = (retry?.number ?? 0) + 1;
        attemptCount = attempt;
        if (retry?.freshThread) {
          thread = createThread();
          latestValidation = undefined;
        }
        const attemptDir = path.join(historyDir, String(attempt));
        let raw: string;
        try {
          raw = await runPlannerTurn({
            signal,
            attempt,
            imagePaths:
              !latestValidation
                ? (input.design.previewImages?.map((image) => image.imagePath) ?? [
                    input.design.previewImagePath,
                  ])
                : undefined,
            moduleDir: attemptDir,
            prompt:
              !latestValidation
                ? buildInitialPrompt(request)
                : buildRetryPrompt({
                    attempt: attempt - 1,
                    validation: latestValidation,
                  }),
            thread,
          });
        } catch (error) {
          signal.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          await writeJsonFile(path.join(attemptDir, "error.json"), { message });
          throw error;
        }
        const parsed = parseModelPlannerResponse(raw);
        latestResponse = parsed.response;
        await writeResponseArtifacts({
          moduleDir: input.moduleDir,
          parsed,
          raw,
        });

        const validation = parsed.error
          ? validationFromIssue(parsed.error)
          : validateModelPlan({
              containerLayout: input.containerLayout,
              response: parsed.response,
              viewport: input.viewport,
            });
        latestValidation = validation;
        await writeResponseArtifacts({ moduleDir: attemptDir, parsed, raw });
        await writeValidationArtifact({ moduleDir: attemptDir, validation });
        await writeValidationArtifact({
          moduleDir: input.moduleDir,
          validation,
        });

        if (!validation.passed) {
          throw new ModelResponseError(`Model planner validation failed: ${
            validation.errors.slice(0, 3).map(issue => issue.message).join('; ') || 'unknown validation error'
          }`);
        }
        const response = parsed.response as ModelPlannerResponse;
        return {
          attemptCount: attempt,
          planned: normalizeModelPlan({
            containerLayout: input.containerLayout,
            response,
            svgLayout: input.svgLayout,
            validation,
            viewport: input.viewport,
          }),
          request,
          response,
          status: "success",
          validation,
        };
      },
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    return {
      attemptCount,
      failureReason: `Model planner failed: ${error instanceof Error ? error.message : String(error)}`,
      request,
      response: latestResponse,
      status: "failed",
      validation: latestValidation,
    };
  }
};

export { runModelPlanner, toValidationSummary };
