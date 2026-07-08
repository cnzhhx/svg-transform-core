import path from "node:path";
import { existsSync } from "node:fs";

import type {
  Session,
  SessionMessage,
} from "../session-store.js";
import { truncate } from "../core/string-utils.js";

const API_EVENT_MESSAGE_TEXT_LIMIT = 100;
const API_REASONING_MESSAGE_TEXT_LIMIT = 4_000;
const API_LOG_TEXT_LIMIT = 2_000;
const API_RECENT_LOG_LIMIT = 80;

const truncateApiText = (value: unknown, limit: number) =>
  truncate(String(value ?? ""), limit, "...");

const isCompletedJobStatus = (status: string) =>
  status === "completed" ||
  status === "best-effort" ||
  status === "failed-gate";

const safeMessagesForApi = (messages: SessionMessage[]) =>
  messages
    .filter((message, index) => {
      if (message.role === "user" && message.kind === "chat") return true;
      if (message.role === "system" && message.kind === "event") return true;
      return index >= messages.length - 100;
    })
    .map((message) => ({
      ...message,
      text: truncateApiText(
        message.text,
        message.agentItemType === "reasoning"
          ? API_REASONING_MESSAGE_TEXT_LIMIT
          : message.kind === "event"
            ? API_EVENT_MESSAGE_TEXT_LIMIT
            : Number.POSITIVE_INFINITY,
      ),
    }));

const safeLogsForApi = (logs: string[]) =>
  logs
    .slice(-API_RECENT_LOG_LIMIT)
    .map((log) => truncateApiText(log, API_LOG_TEXT_LIMIT));

type PublicJobResult = Record<string, unknown> & {
  downloadUrl?: string;
  fileBaseUrl: string;
  previewUrl?: string;
};

const publicResultForJob = (
  job: Session,
  { baseUrl }: { baseUrl: string },
): PublicJobResult => {
  const result = job.result;
  const relativePath = (value: unknown) => {
    if (typeof value !== "string" || !value) return undefined;
    const relative = path.relative(job.sessionDir, value);
    if (
      relative &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    ) {
      return relative.replace(/\\/g, "/");
    }
    return undefined;
  };
  const relativeOutputTarget = result.outputTarget
    ? {
        compareEntryPath: relativePath(result.outputTarget.compareEntryPath),
        format: result.outputTarget.format,
        frameworkBuildDir: relativePath(result.outputTarget.frameworkBuildDir),
        renderEntryPath: relativePath(result.outputTarget.renderEntryPath),
        sourceEntryPath: relativePath(result.outputTarget.sourceEntryPath),
        sourceStylePath: relativePath(result.outputTarget.sourceStylePath),
      }
    : undefined;
  const previewPath = result.livePreviewEntryPath ?? result.renderEntryPath;
  const previewUrl = previewPath && existsSync(previewPath)
    ? `${baseUrl}/preview`
    : undefined;
  return {
    artifactDir: relativePath(result.artifactDir),
    cachedInputTokens: result.cachedInputTokens,
    compareEntryPath: relativePath(result.compareEntryPath),
    containerLayoutPath: relativePath(result.containerLayoutPath),
    designHeight: result.designHeight,
    designWidth: result.designWidth,
    diffRatio: result.diffRatio,
    downloadUrl: isCompletedJobStatus(job.status)
      ? `${baseUrl}/download`
      : undefined,
    fileBaseUrl: `${baseUrl}/files/`,
    inputTokens: result.inputTokens,
    livePreviewEntryPath: relativePath(result.livePreviewEntryPath),
    livePreviewUpdatedAt: result.livePreviewUpdatedAt,
    livePreviewVersion: result.livePreviewVersion,
    modelUsageRecords: result.modelUsageRecords,
    moduleActiveIds: result.moduleActiveIds,
    moduleAgentRuns: result.moduleAgentRuns,
    moduleConcurrencyLimit: result.moduleConcurrencyLimit,
    moduleCount: result.moduleCount,
    moduleCountExceedsConcurrency: result.moduleCountExceedsConcurrency,
    moduleFailedIds: result.moduleFailedIds,
    moduleFailureKinds: result.moduleFailureKinds,
    moduleFailures: result.moduleFailures,
    moduleMergeManifestPath: relativePath(result.moduleMergeManifestPath),
    modulePlanMode: result.modulePlanMode,
    modulePlanModules: result.modulePlanModules,
    modulePlanPath: relativePath(result.modulePlanPath),
    outputTarget: relativeOutputTarget,
    outputTokens: result.outputTokens,
    previewUrl,
    renderEntryPath: relativePath(result.renderEntryPath),
    renderPngPath: relativePath(result.renderPngPath),
    sourceEntryPath: relativePath(result.sourceEntryPath),
    sourceStylePath: relativePath(result.sourceStylePath),
    svgPngPath: relativePath(result.svgPngPath),
    tokensUsed: result.tokensUsed,
    uncachedInputTokens: result.uncachedInputTokens,
    verifyMode: result.verifyMode,
  };
};

const jobForApi = (
  job: Session,
  { baseUrl = "/api/jobs" }: { baseUrl?: string } = {},
) => {
  const jobUrl = `${baseUrl}/${job.id}`;
  return {
    activeStep: job.activeStep,
    createdAt: job.createdAt,
    designName: job.designName,
    error: job.error,
    eventsUrl: `${jobUrl}/events`,
    id: job.id,
    jobId: job.id,
    logs: safeLogsForApi(job.logs),
    messages: safeMessagesForApi(job.messages),
    outputFormat: job.outputFormat,
    progress: job.progress,
    result: publicResultForJob(job, { baseUrl: jobUrl }),
    scale: job.scale,
    status: job.status,
    steps: job.steps,
    updatedAt: job.updatedAt,
  };
};

export { isCompletedJobStatus, jobForApi };
