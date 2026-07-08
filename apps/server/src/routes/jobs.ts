import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

import archiver from "archiver";
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";

import {
  getSessionChatDisabled,
  getSessionDeleteDisabled,
} from "../config/index.js";
import {
  getOutputFormatLabel,
  parseOutputFormat,
  resolveOutputTarget,
} from "../core/output-target.js";
import type { OutputFormat } from "../core/output-target.js";
import { getWorkspaceRoot, isInsidePath } from "../core/paths.js";
import { isCompletedJobStatus, jobForApi } from "./job-api.js";
import { cancelSessionRun, enqueueSession } from "../pipeline/agent-runner/index.js";
import {
  sessionStore,
  type Session,
} from "../session-store.js";

const router = Router();

const JOB_DELETE_CLEANUP_ATTEMPTS = 3;

const getJobsRoot = () => path.join(getWorkspaceRoot(), "jobs");
const getJobDir = (jobId: string) => path.join(getJobsRoot(), jobId);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeOriginalName = (value: string) =>
  path.basename(Buffer.from(value, "latin1").toString("utf8"));

const isSvgFileName = (value: string) =>
  path.extname(value).toLowerCase() === ".svg";

const getSvgDesignName = (value: string) =>
  path.basename(value, path.extname(value)).trim();

const parseScale = (value: unknown) => {
  const parsed = Number(value);
  if (parsed === 2) return 2;
  return 1;
};

const parseDryRun = (value: unknown) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const JOB_CREATE_FIELD_KEYS = new Set([
  "dryRun",
  "outputFormat",
  "scale",
]);

const findUnsupportedCreateField = (body: unknown) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (
    Object.keys(body as Record<string, unknown>).find(
      (key) => !JOB_CREATE_FIELD_KEYS.has(key),
    ) ?? null
  );
};

const canStartJob = (status: string) =>
  status === "draft" ||
  status === "failed" ||
  isCompletedJobStatus(status);

const canAcceptMessage = (status: string) => status !== "queued";

const createUploadMiddleware = () =>
  multer({
    storage: multer.memoryStorage(),
    fileFilter: (_req, file, cb) => {
      const name = decodeOriginalName(file.originalname);
      const designName = getSvgDesignName(name);
      if (isSvgFileName(name) && designName) {
        cb(null, true);
      } else {
        cb(new Error("Only named SVG files are accepted"));
      }
    },
    limits: { fileSize: 50 * 1024 * 1024 },
  }).single("svg");

router.post("/jobs", async (req, res) => {
  const upload = createUploadMiddleware();
  let jobId: string | undefined;

  upload(req, res, async (error) => {
    const cleanup = async () => {
      if (jobId) {
        await rm(getJobDir(jobId), { force: true, recursive: true });
      }
    };
    const badRequest = async (message: string) => {
      await cleanup();
      res.status(400).json({ error: message });
    };

    try {
      if (error) {
        await badRequest(error.message);
        return;
      }

      const file = req.file;
      if (!file) {
        await badRequest("No SVG file provided");
        return;
      }

      const unsupportedField = findUnsupportedCreateField(req.body);
      if (unsupportedField) {
        await badRequest(`Unsupported job field: ${unsupportedField}`);
        return;
      }

      const originalName = decodeOriginalName(file.originalname);
      const designName = getSvgDesignName(originalName);
      if (!designName) {
        await badRequest("SVG filename cannot be empty");
        return;
      }

      const scale = parseScale(req.body?.scale);
      let outputFormat: OutputFormat;
      try {
        outputFormat = req.body?.outputFormat === undefined
          ? "html"
          : parseOutputFormat(req.body.outputFormat);
      } catch (caughtError) {
        const message = caughtError instanceof Error
          ? caughtError.message
          : String(caughtError);
        await badRequest(message);
        return;
      }

      jobId = nanoid(10);
      const jobDir = getJobDir(jobId);
      await mkdir(jobDir, { recursive: true });
      const svgPath = path.join(jobDir, originalName);
      await writeFile(svgPath, file.buffer);

      const artifactDir = path.join(jobDir, "artifacts");
      const outputTarget = resolveOutputTarget({
        format: outputFormat,
        svgPath,
      });

      const job = sessionStore.create({
        id: jobId,
        designName,
        svgPath,
        scale,
        artifactDir,
        sessionDir: jobDir,
        outputFormat,
        outputTarget,
        status: "draft",
        activeStep: null,
        steps: {
          agent: { status: "pending" },
          verify: { status: "pending" },
        },
        result: {
          artifactDir,
          compareEntryPath: outputTarget.compareEntryPath,
          outputTarget,
          renderEntryPath: outputTarget.renderEntryPath,
          sourceEntryPath: outputTarget.sourceEntryPath,
          sourceStylePath: outputTarget.sourceStylePath,
        },
        logs: [],
        messages: [
          {
            id: `system-${jobId}`,
            role: "system",
            kind: "chat",
            text:
              `Created job ${jobId} for ${originalName}. Output format: ${getOutputFormatLabel(outputFormat)}. The core service will run SVG analysis, module generation, merge, verification, and artifact export.`,
            createdAt: Date.now(),
          },
        ],
        pendingUserMessages: [],
      });

      if (!parseDryRun(req.body?.dryRun)) {
        enqueueSession(job.id);
      }

      res.status(202).json(jobForApi(job, { baseUrl: "/api/jobs" }));
    } catch (caughtError) {
      await cleanup();
      const message = caughtError instanceof Error
        ? caughtError.message
        : String(caughtError);
      res.status(500).json({ error: message });
    }
  });
});

router.get("/jobs", (_req, res) => {
  res.json(
    sessionStore.list().map((job) => jobForApi(job, { baseUrl: "/api/jobs" })),
  );
});

router.get("/jobs/:id", (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(jobForApi(job, { baseUrl: "/api/jobs" }));
});

router.post("/jobs/:id/start", (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (job.status === "queued" || job.status === "running") {
    res.json({ jobId: job.id, status: job.status });
    return;
  }
  if (!canStartJob(job.status)) {
    res.status(409).json({ error: `Cannot start job from status ${job.status}` });
    return;
  }
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    res.status(400).json({ error: "Unsupported start body" });
    return;
  }
  enqueueSession(job.id);
  res.json({ jobId: job.id, status: "queued" });
});

router.post("/jobs/:id/messages", (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  const text = String(req.body?.text ?? "").trim();
  const moduleId = String(req.body?.moduleId ?? "").trim();
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (getSessionChatDisabled()) {
    res.status(403).json({ error: "Chat repair is disabled" });
    return;
  }
  if (!text) {
    res.status(400).json({ error: "Message text is required" });
    return;
  }
  if (!moduleId) {
    res.status(400).json({ error: "moduleId is required" });
    return;
  }
  const knownModules = job.result.modulePlanModules ?? [];
  if (
    knownModules.length > 0 &&
    !knownModules.some((module) => module.id === moduleId)
  ) {
    res.status(404).json({ error: `Module not found: ${moduleId}` });
    return;
  }
  if (knownModules.length === 0) {
    res.status(409).json({
      error: "Module repair is available after module planning has produced module ids",
    });
    return;
  }
  if (!canAcceptMessage(job.status)) {
    res.status(409).json({ error: `Cannot enqueue message from status ${job.status}` });
    return;
  }

  const createdMessage = sessionStore.addMessage(
    job.id,
    {
      id: `user-${Date.now()}`,
      kind: "chat",
      moduleId,
      role: "user",
      text,
    },
    { enqueueForAgent: true },
  );
  const guidanceStatus = job.status === "running" ? "queued-for-guidance" : "queued";
  if (job.status !== "running") {
    enqueueSession(job.id);
  }
  res.status(202).json({
    guidanceStatus,
    jobId: job.id,
    message: createdMessage,
    status: job.status === "running" ? "running" : "queued",
  });
});

const resolveJobFilePath = (job: Session, rawPath: string) => {
  const relativePath = rawPath.replace(/^\/+/, "");
  const filePath = path.resolve(job.sessionDir, relativePath);
  const sessionDir = path.resolve(job.sessionDir);
  if (!isInsidePath(sessionDir, filePath)) {
    throw new Error("File path is outside job directory");
  }
  return filePath;
};

router.get("/jobs/:id/preview", (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const previewPath = job.result.livePreviewEntryPath ?? job.result.renderEntryPath;
  if (!previewPath || !existsSync(previewPath)) {
    res.status(404).json({ error: "Preview not available" });
    return;
  }
  res.sendFile(previewPath);
});

router.get("/jobs/:id/files/*path", (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  try {
    const pathParam = req.params["path"];
    const rawPath = Array.isArray(pathParam)
      ? pathParam.join("/")
      : String(pathParam ?? "");
    const filePath = resolveJobFilePath(job, rawPath);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.sendFile(filePath);
  } catch (caughtError) {
    const message = caughtError instanceof Error
      ? caughtError.message
      : String(caughtError);
    res.status(400).json({ error: message });
  }
});

router.get("/jobs/:id/download", async (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!existsSync(job.sessionDir)) {
    res.status(404).json({ error: "Job directory not found" });
    return;
  }

  const zipName = `${job.designName || job.id}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
  );

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (archiveError) => {
    if (!res.headersSent) {
      res.status(500).json({ error: archiveError.message });
      return;
    }
    res.destroy(archiveError);
  });
  archive.pipe(res);
  archive.directory(job.sessionDir, job.designName || job.id);
  await archive.finalize();
});

const forceDeleteJobFilesWithRetry = async (job: Session) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= JOB_DELETE_CLEANUP_ATTEMPTS; attempt++) {
    try {
      await sessionStore.forceDeleteSessionFiles(job);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < JOB_DELETE_CLEANUP_ATTEMPTS) await delay(250 * attempt);
    }
  }
  throw lastError;
};

const scheduleForceDeleteJobFiles = (job: Session, phase: "initial" | "final") => {
  void forceDeleteJobFilesWithRetry(job).catch((error) => {
    console.error(`[job-delete] ${phase} cleanup failed (${job.id}):`, error);
  });
};

router.delete("/jobs/:id", async (req, res) => {
  if (getSessionDeleteDisabled()) {
    res.status(403).json({ error: "Job deletion is disabled" });
    return;
  }

  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const canceledRun =
    job.status === "queued" || job.status === "running"
      ? cancelSessionRun(job.id)
      : undefined;
  try {
    const deletedJob = canceledRun?.active
      ? sessionStore.detachSession(job.id)
      : await sessionStore.deleteSession(job.id);
    if (canceledRun?.active && deletedJob) {
      scheduleForceDeleteJobFiles(deletedJob, "initial");
      void canceledRun.finished.then(() => {
        scheduleForceDeleteJobFiles(deletedJob, "final");
      });
    }
    res.json({ deleted: true, jobId: job.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (canceledRun?.queued && sessionStore.get(job.id)) {
      enqueueSession(job.id);
    }
    res.status(500).json({ error: message });
  }
});

router.get("/jobs/:id/token-split", (req, res) => {
  const job = sessionStore.get(String(req.params["id"] ?? ""));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  const eventsPath = path.join(job.sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) {
    res.json({});
    return;
  }

  let cachedInputTokens = 0;
  let eventInputTokens = 0;
  try {
    for (const line of readFileSync(eventsPath, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as {
        event?: {
          type?: string;
          usage?: {
            cached_input_tokens?: number;
            input_tokens?: number;
          };
        };
        type?: string;
      };
      if (
        parsed.type !== "agent:event" ||
        parsed.event?.type !== "turn.completed"
      ) {
        continue;
      }
      const usage = parsed.event.usage;
      cachedInputTokens += Number(usage?.cached_input_tokens ?? 0);
      eventInputTokens += Number(usage?.input_tokens ?? 0);
    }
  } catch {
    res.json({});
    return;
  }

  const inputTokens = Number(job.result.inputTokens ?? eventInputTokens);
  res.json({
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
  });
});

export default router;
