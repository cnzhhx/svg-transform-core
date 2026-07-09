type FetchLike = typeof fetch;

type CoreOutputFormat = "html" | "vue" | "react";

type CoreJobStatus =
  | "draft"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "best-effort"
  | "failed-gate";

type CoreStepState = {
  completedAt?: number;
  error?: string;
  startedAt?: number;
  status: "pending" | "running" | "completed" | "failed";
};

type CoreWorkflowNodeKey = "upload" | "analysis" | "agent" | "verify" | "done";

type CoreWorkflowProgress = {
  currentNode: CoreWorkflowNodeKey | null;
  detail?: string;
  iteration: number;
  maxIterations?: number;
  nodes: Record<CoreWorkflowNodeKey, CoreStepState & { label: string }>;
};

type CoreJobMessage = {
  agentEventType?: "item.completed" | "item.started" | "item.updated";
  agentItemType?:
    | "agent_message"
    | "command_execution"
    | "error"
    | "mcp_tool_call"
    | "reasoning";
  createdAt: number;
  id: string;
  kind: "chat" | "event";
  moduleId?: string;
  role: "system" | "user" | "assistant";
  sourceLabel?: string;
  text: string;
};

type CoreJobResult = Record<string, unknown> & {
  downloadUrl?: string;
  fileBaseUrl?: string;
  previewUrl?: string;
};

type CoreJob = {
  activeStep: "agent" | "verify" | null;
  createdAt: number;
  designName: string;
  error?: string;
  eventsUrl: string;
  id: string;
  jobId: string;
  logs: string[];
  messages: CoreJobMessage[];
  model: string;
  outputFormat: CoreOutputFormat;
  progress?: CoreWorkflowProgress;
  result: CoreJobResult;
  scale?: number;
  status: CoreJobStatus;
  steps: Record<"agent" | "verify", CoreStepState>;
  updatedAt: number;
};

type CoreJobSummary = CoreJob;

type CoreJobEvent =
  | {
      job: CoreJob;
      timestamp: number;
      type: "init";
    }
  | {
      jobId: string;
      patch?: Partial<CoreJob>;
      timestamp: number;
      type: "job:updated" | "job:deleted";
    }
  | {
      [key: string]: unknown;
      jobId?: string;
      timestamp?: number;
      type: string;
    };

type CoreCreateJobOptions = {
  dryRun?: boolean;
  model?: string;
  outputFormat?: CoreOutputFormat;
  scale?: number;
};

type CoreCreateJobResponse = CoreJob & {
  jobId: string;
};

type CoreStartJobResponse = {
  jobId: string;
  status: CoreJobStatus;
};

type CoreSendJobMessageResponse = {
  guidanceStatus?: string;
  jobId: string;
  message?: CoreJobMessage;
  status: CoreJobStatus;
};

type CoreDeleteJobResponse = {
  deleted: boolean;
  jobId: string;
};

type CoreClientOptions = {
  baseUrl: string;
  fetch?: FetchLike;
};

type CoreUploadFile = Blob | File | Buffer | Uint8Array | ArrayBuffer;

type CoreUploadInput = {
  file: CoreUploadFile;
  filename?: string;
  type?: string;
};

type CoreEventHandlers = {
  onError?: (error: unknown) => void;
  onEvent?: (event: CoreJobEvent) => void;
  onOpen?: () => void;
};

type CoreEventConnection = {
  close: () => void;
};

class CoreClientError extends Error {
  payload?: unknown;
  status: number;

  constructor(message: string, status: number, payload?: unknown) {
    super(message);
    this.name = "CoreClientError";
    this.status = status;
    this.payload = payload;
  }
}

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const encodePath = (value: string) =>
  value.split("/").filter(Boolean).map(encodeURIComponent).join("/");

const normalizeFileInput = (file: CoreUploadFile | CoreUploadInput): CoreUploadInput => {
  if (
    file &&
    typeof file === "object" &&
    "file" in file
  ) {
    return file as CoreUploadInput;
  }
  return { file: file as CoreUploadFile };
};

const toBlob = (file: CoreUploadFile, type = "image/svg+xml") => {
  if (file instanceof Blob) return file;
  if (file instanceof ArrayBuffer) return new Blob([file], { type });
  return new Blob([new Uint8Array(file)], { type });
};

const readErrorMessage = async (response: Response) => {
  try {
    const payload = await response.json();
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error || response.statusText)
        : response.statusText;
    return new CoreClientError(message || "Core request failed", response.status, payload);
  } catch {
    return new CoreClientError(response.statusText || "Core request failed", response.status);
  }
};

const parseSseEvents = (chunk: string) => {
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return [];
  return dataLines.flatMap((line) => {
    try {
      return [JSON.parse(line) as CoreJobEvent];
    } catch {
      return [];
    }
  });
};

const createSvgTransformClient = ({ baseUrl, fetch: customFetch }: CoreClientOptions) => {
  const fetchImpl = customFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is required to create svg-transform core client");
  }
  const base = trimTrailingSlash(baseUrl);
  const url = (path: string) => `${base}${path}`;

  const request = async (path: string, init?: RequestInit) => {
    let response: Response;
    try {
      response = await fetchImpl(url(path), init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CoreClientError(`Core service unavailable: ${message}`, 502);
    }
    if (!response.ok) throw await readErrorMessage(response);
    return response;
  };

  const requestJson = async <T>(path: string, init?: RequestInit) =>
    (await request(path, init).then((response) => response.json())) as T;

  const createJob = (
    uploadFile: CoreUploadFile | CoreUploadInput,
    options: CoreCreateJobOptions = {},
  ) => {
    const input = normalizeFileInput(uploadFile);
    const form = new FormData();
    form.append(
      "svg",
      toBlob(input.file, input.type),
      input.filename ?? "design.svg",
    );
    if (options.model) form.append("model", options.model);
    if (options.outputFormat) form.append("outputFormat", options.outputFormat);
    if (options.scale !== undefined) form.append("scale", String(options.scale));
    if (options.dryRun !== undefined) form.append("dryRun", String(options.dryRun));
    return requestJson<CoreCreateJobResponse>("/api/jobs", {
      body: form,
      method: "POST",
    });
  };

  const connectJobEvents = (
    id: string,
    handlers: CoreEventHandlers,
  ): CoreEventConnection => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await request(`/api/jobs/${encodeURIComponent(id)}/events`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        handlers.onOpen?.();
        if (!response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/\n\n/);
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            for (const event of parseSseEvents(part)) handlers.onEvent?.(event);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) handlers.onError?.(error);
      }
    })();
    return { close: () => controller.abort() };
  };

  return {
    baseUrl: base,
    connectJobEvents,
    createJob,
    deleteJob: (id: string) =>
      requestJson<CoreDeleteJobResponse>(`/api/jobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    getJob: (id: string) =>
      requestJson<CoreJob>(`/api/jobs/${encodeURIComponent(id)}`),
    health: async () => (await request("/health")).text(),
    jobDownloadUrl: (id: string) => url(`/api/jobs/${encodeURIComponent(id)}/download`),
    jobFileUrl: (id: string, path: string) =>
      url(`/api/jobs/${encodeURIComponent(id)}/files/${encodePath(path)}`),
    jobPreviewUrl: (id: string) => url(`/api/jobs/${encodeURIComponent(id)}/preview`),
    listJobs: () => requestJson<CoreJobSummary[]>("/api/jobs"),
    request,
    requestJson,
    sendJobMessage: (id: string, moduleId: string, text: string) =>
      requestJson<CoreSendJobMessageResponse>(`/api/jobs/${encodeURIComponent(id)}/messages`, {
        body: JSON.stringify({ moduleId, text }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    startJob: (id: string) =>
      requestJson<CoreStartJobResponse>(`/api/jobs/${encodeURIComponent(id)}/start`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
  };
};

type SvgTransformClient = ReturnType<typeof createSvgTransformClient>;

export {
  CoreClientError,
  createSvgTransformClient,
};

export type {
  CoreCreateJobOptions,
  CoreCreateJobResponse,
  CoreDeleteJobResponse,
  CoreEventConnection,
  CoreEventHandlers,
  CoreJob,
  CoreJobEvent,
  CoreJobStatus,
  CoreJobSummary,
  CoreOutputFormat,
  CoreSendJobMessageResponse,
  CoreStartJobResponse,
  CoreUploadFile,
  CoreUploadInput,
  SvgTransformClient,
};
