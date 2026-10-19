# @svg-transform/core-client

Lightweight HTTP client for `svg-transform-core`.

This package talks to a running core service. It does not include the server
pipeline, model runtime, browser runtime, Docker image, or product/business
logic.

## Install

```bash
npm install @svg-transform/core-client
```

## Quick Start

```ts
import { readFile } from "node:fs/promises";
import { createSvgTransformClient } from "@svg-transform/core-client";

const client = createSvgTransformClient({
  baseUrl: "http://127.0.0.1:4310",
});

const svg = await readFile("./design.svg");
const job = await client.createJob(
  { file: svg, filename: "design.svg" },
  { model: "main", outputFormat: "html", scale: 1 },
);

let current = await client.getJob(job.jobId);
while (!["completed", "best-effort", "failed", "failed-gate"].includes(current.status)) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  current = await client.getJob(job.jobId);
}

console.log(current.status);
console.log(client.jobPreviewUrl(job.jobId));
console.log(client.jobDownloadUrl(job.jobId));
```

## Events

```ts
const connection = client.connectJobEvents(job.jobId, {
  onOpen: () => console.log("connected"),
  onEvent: (event) => console.log(event.type),
  onError: (error) => console.error(error),
});

connection.close();
```

SSE reconnects after transient errors or an unexpected end of stream, with
bounded exponential backoff. Each connection starts with a fresh `init`
snapshot; replace local state with that snapshot. Intermediate events are not
replayed. `job:updated` carries `job`, and `job:deleted` closes the connection.
Set `reconnect: false` to disable retries or use `onReconnect(attempt)` to
observe them. Call `close()` when finished to stop pending reconnects.

Normal HTTP requests have a 30-second default timeout. Configure `timeoutMs`
and `headers` on the client, or pass `{ signal, timeoutMs }` as the final request
argument (`getJob(id, options)`, `createJob(file, options, requestOptions)`, etc.).
Aborts retain their abort/timeout error rather than becoming HTTP 502 errors.
The long-lived SSE stream has no overall request deadline.

`client.readiness()` queries runtime readiness. Completion and visual quality
are separate: inspect `job.result.quality` alongside `job.status`.
`jobDownloadUrl(id)` returns the final deliverable; use
`jobDownloadUrl(id, 'diagnostic')` for analysis and runtime history.

## Repair

```ts
await client.sendJobMessage(
  job.jobId,
  "module-001",
  "Make this module closer to the source SVG.",
);
```

## API

- `health()`
- `createJob(fileOrInput, options)`
- `startJob(jobId)`
- `getJob(jobId)`
- `listJobs()`
- `connectJobEvents(jobId, handlers)`
- `sendJobMessage(jobId, moduleId, text)`
- `jobPreviewUrl(jobId)`
- `jobDownloadUrl(jobId)`
- `jobFileUrl(jobId, path)`
- `deleteJob(jobId)`

Supported `outputFormat` values are `html`, `vue`, `react`, and `flutter`.

Jobs are queued automatically unless they are created with `dryRun: true`.
Call `startJob(jobId)` to start a draft job created in dry-run mode.

## Runtime Requirements

Use Node.js 20.19+ or another runtime with `fetch`, `Blob`, and `FormData`.
