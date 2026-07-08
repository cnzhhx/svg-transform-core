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
  { outputFormat: "html", scale: 1 },
);

await client.startJob(job.jobId);

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

Supported `outputFormat` values are `html`, `vue`, and `react`.

## Runtime Requirements

Use Node.js 20+ or another runtime with `fetch`, `Blob`, and `FormData`.
