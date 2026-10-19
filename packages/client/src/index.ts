type FetchLike = typeof fetch;

type CoreOutputFormat = "html" | "vue" | "react" | "flutter";

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
  quality?: { status: 'pass' | 'partial'; softIssues: string[]; blockingIssues: string[]; gateSummary: Record<string, unknown> };
  stageTimings?: Record<string, number>;
  deliverable?: { version: string; manifestPath?: string };
  moduleValidationRuns?: Array<Record<string, unknown>>;
  diagnosticDownloadUrl?: string;
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
  persistence?: { errorCount: number; healthy: boolean };
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
      job: CoreJob;
      patch?: Partial<CoreJob>;
      timestamp: number;
      type: "job:updated";
    }
  | { jobId: string; timestamp: number; type: 'job:deleted' }
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
  headers?: HeadersInit;
  timeoutMs?: number;
};

type CoreRequestOptions = { signal?: AbortSignal; timeoutMs?: number };

type CoreUploadFile = Blob | File | Uint8Array | ArrayBuffer;

type CoreUploadInput = {
  file: CoreUploadFile;
  filename?: string;
  type?: string;
};

type CoreEventHandlers = {
  onReconnect?: (attempt: number) => void;
  reconnect?: boolean;
  reconnectDelayMs?: number;
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
  return [dataLines.join('\n')].flatMap((line) => {
    try {
      return [JSON.parse(line) as CoreJobEvent];
    } catch {
      return [];
    }
  });
};

const createSvgTransformClient = ({ baseUrl, fetch: customFetch, headers, timeoutMs = 30_000 }: CoreClientOptions) => {
  const fetchImpl = customFetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is required to create svg-transform core client");
  }
  const base = trimTrailingSlash(baseUrl);
  const url = (path: string) => `${base}${path}`;

  const request = async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    const timeout = init?.timeoutMs ?? timeoutMs;
    const signals = [init?.signal, timeout > 0 ? AbortSignal.timeout(timeout) : undefined].filter((value): value is AbortSignal => Boolean(value));
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const requestHeaders = new Headers(headers);
    new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
    let response: Response;
    try {
      response = await fetchImpl(url(path), { ...init, signal: signal ?? null, headers: requestHeaders });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : String(error);
      throw new CoreClientError(`Core service unavailable: ${message}`, 502);
    }
    if (!response.ok) throw await readErrorMessage(response);
    return response;
  };

  const requestJson = async <T>(path: string, init?: RequestInit & { timeoutMs?: number }) =>
    (await request(path, init).then((response) => response.json())) as T;

  const createJob = (
    uploadFile: CoreUploadFile | CoreUploadInput,
    options: CoreCreateJobOptions = {},
    requestOptions: CoreRequestOptions = {},
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
      ...requestOptions,
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
      let attempt = 0;
      while (!controller.signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await request(`/api/jobs/${encodeURIComponent(id)}/events`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
          timeoutMs: 0,
        });
        handlers.onOpen?.();
        if (!response.body) return;
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 8 * 1024 * 1024) throw new Error('SSE frame exceeds 8 MiB');
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            for (const event of parseSseEvents(part)) {
              handlers.onEvent?.(event);
              if (event.type === 'init') attempt = 0;
              if (event.type === 'job:deleted') controller.abort();
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) handlers.onError?.(error);
        if (error instanceof CoreClientError && error.status >= 400 && error.status < 500 && error.status !== 429) return;
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
      if (controller.signal.aborted || handlers.reconnect === false) return;
      attempt++;
      handlers.onReconnect?.(attempt);
      const delay = Math.min(30_000, (handlers.reconnectDelayMs ?? 1000) * 2 ** Math.min(attempt - 1, 5));
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, delay);
        (timer as unknown as { unref?: () => void }).unref?.();
        controller.signal.addEventListener('abort', finish, { once: true });
        if (controller.signal.aborted) finish();
      });
      }
    })();
    return { close: () => controller.abort() };
  };

  return {
    baseUrl: base,
    connectJobEvents,
    createJob,
    deleteJob: (id: string, options: CoreRequestOptions = {}) =>
      requestJson<CoreDeleteJobResponse>(`/api/jobs/${encodeURIComponent(id)}`, {
        ...options,
        method: "DELETE",
      }),
    getJob: (id: string, options: CoreRequestOptions = {}) =>
      requestJson<CoreJob>(`/api/jobs/${encodeURIComponent(id)}`, options),
    health: async (options: CoreRequestOptions = {}) => (await request("/health", options)).text(),
    readiness: async (options: CoreRequestOptions = {}) => requestJson<Record<string, unknown>>("/ready", options),
    jobDownloadUrl: (id: string, kind: 'deliverable' | 'diagnostic' = 'deliverable') => url(`/api/jobs/${encodeURIComponent(id)}/download${kind === 'diagnostic' ? '?kind=diagnostic' : ''}`),
    jobFileUrl: (id: string, path: string) =>
      url(`/api/jobs/${encodeURIComponent(id)}/files/${encodePath(path)}`),
    jobPreviewUrl: (id: string) => url(`/api/jobs/${encodeURIComponent(id)}/preview`),
    listJobs: (options: CoreRequestOptions = {}) => requestJson<CoreJobSummary[]>("/api/jobs", options),
    request,
    requestJson,
    sendJobMessage: (id: string, moduleId: string, text: string, options: CoreRequestOptions = {}) =>
      requestJson<CoreSendJobMessageResponse>(`/api/jobs/${encodeURIComponent(id)}/messages`, {
        ...options,
        body: JSON.stringify({ moduleId, text }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    startJob: (id: string, options: CoreRequestOptions = {}) =>
      requestJson<CoreStartJobResponse>(`/api/jobs/${encodeURIComponent(id)}/start`, {
        ...options,
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
  CoreClientOptions,
  CoreRequestOptions,
  CoreJobResult,
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
