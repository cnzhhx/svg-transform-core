# svg-transform-core

Core SVG transform service plus a lightweight HTTP client SDK.

Published artifacts:

- Docker image: `ghcr.io/cnzhhx/svg-transform-core:0.2.0`
- npm SDK: `@svg-transform/core-client`

The service is intentionally core-only. It does not include account systems,
billing, quotas, orders, tenant rules, or a business frontend.

## Quick Start

### Run the service

Create a runtime directory, model config, and env file:

```bash
mkdir -p .runtime workspace

curl -fsSL \
  https://raw.githubusercontent.com/cnzhhx/svg-transform-core/main/apps/server/config/model-provider.example.json \
  -o .runtime/model-provider.json

cat > .runtime/core.env <<'EOF'
YOUR_PROVIDER_API_KEY=replace-me
EOF
```

Edit `.runtime/model-provider.json` so each entry in `models` has the right
`baseURL`, `provider`, provider model id, and `apiKeyEnv`. Keep real keys in
`.runtime/core.env`.

Start the published Docker image:

```bash
docker run -d \
  --name svg-transform-core \
  -p 4310:4310 \
  --env-file .runtime/core.env \
  -e MAX_CONCURRENT_AGENTS=2 \
  -e MAX_PARALLEL_MODULE_AGENTS=5 \
  -v "$PWD/workspace:/app/workspace" \
  -v "$PWD/.runtime/model-provider.json:/app/config/model-provider.json:ro" \
  ghcr.io/cnzhhx/svg-transform-core:0.2.0
```

Check health:

```bash
curl http://127.0.0.1:4310/health
```

### Create a transform job

Upload an SVG:

```bash
curl -F svg=@design.svg \
  -F model=main \
  -F outputFormat=html \
  -F scale=1 \
  http://127.0.0.1:4310/api/jobs
```

Start the returned `jobId`:

```bash
curl -X POST http://127.0.0.1:4310/api/jobs/<jobId>/start
```

Inspect, preview, or download:

```bash
curl http://127.0.0.1:4310/api/jobs/<jobId>
open http://127.0.0.1:4310/api/jobs/<jobId>/preview
curl -L -o result.zip http://127.0.0.1:4310/api/jobs/<jobId>/download
```

Send a repair instruction:

```bash
curl -H 'Content-Type: application/json' \
  -d '{"moduleId":"module-001","text":"Make this module closer to the source SVG."}' \
  http://127.0.0.1:4310/api/jobs/<jobId>/messages
```

## Client SDK

Install:

```bash
npm install @svg-transform/core-client
```

Use it from Node.js or any runtime that provides `fetch`, `Blob`, and
`FormData`:

```ts
import { readFile } from "node:fs/promises";
import { createSvgTransformClient } from "@svg-transform/core-client";

const client = createSvgTransformClient({
  baseUrl: "http://127.0.0.1:4310",
});

console.log(await client.health());

const svg = await readFile("./design.svg");
const job = await client.createJob(
  { file: svg, filename: "design.svg" },
  { model: "main", outputFormat: "html", scale: 1 },
);

const events = client.connectJobEvents(job.jobId, {
  onEvent: (event) => console.log(event.type),
  onError: (error) => console.error(error),
});

await client.startJob(job.jobId);

const terminal = new Set(["completed", "best-effort", "failed", "failed-gate"]);
let current = await client.getJob(job.jobId);

while (!terminal.has(current.status)) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  current = await client.getJob(job.jobId);
}

events.close();

console.log("status", current.status);
console.log("preview", client.jobPreviewUrl(job.jobId));
console.log("download", client.jobDownloadUrl(job.jobId));
```

SDK methods:

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

## Model Configuration

The model provider config is runtime data, not image content. Docker reads it
from `/app/config/model-provider.json`.

Minimal shape:

```json
{
  "models": {
    "main": {
      "runtime": "opencode",
      "wireApi": "anthropic/chat-completions/responses",
      "provider": "your-provider",
      "baseURL": "https://api.example.com/v1",
      "apiKeyEnv": "YOUR_PROVIDER_API_KEY",
      "model": "your-model-id",
      "modalities": {
        "input": ["text", "image"],
        "output": ["text"]
      }
    }
  }
}
```

`models` is an object map. The upload `model` field selects one of its keys; if
the upload omits `model`, the service uses the first key in `models`. Nested
`models.<name>.model` is the provider model id.

Use `apiKeyEnv` and pass the actual key through Docker:

```bash
cat > .runtime/core.env <<'EOF'
YOUR_PROVIDER_API_KEY=replace-me
EOF
```

## API

- `GET /health`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `POST /api/jobs/:id/start`
- `POST /api/jobs/:id/messages`
- `GET /api/jobs/:id/events`
- `GET /api/jobs/:id/preview`
- `GET /api/jobs/:id/files/*`
- `GET /api/jobs/:id/download`
- `DELETE /api/jobs/:id`

## Docker

Pull the published image:

```bash
docker pull ghcr.io/cnzhhx/svg-transform-core:0.2.0
```

The `latest` tag is also updated on version releases:

```bash
docker pull ghcr.io/cnzhhx/svg-transform-core:latest
```

If you are working inside this repository, the local helper can manage the
container:

```bash
mkdir -p .runtime
cp apps/server/config/model-provider.example.json .runtime/model-provider.json
SVG_TRANSFORM_CORE_IMAGE=ghcr.io/cnzhhx/svg-transform-core:0.2.0 pnpm docker:recreate
```

Useful helper commands:

```bash
pnpm docker:status
pnpm docker:logs
pnpm docker:health
pnpm docker:stop
pnpm docker:recreate
```

`docker:start` starts an existing container when it already exists. If you
changed Docker env, port, volume, image, or model config path, use
`pnpm docker:recreate` so Docker receives the new create-time settings.

Optional helper overrides:

```bash
PORT=4311 pnpm docker:recreate
SVG_TRANSFORM_CORE_ENV_FILE=.runtime/core.env pnpm docker:recreate
SVG_TRANSFORM_CORE_MODEL_CONFIG=/absolute/path/model-provider.json pnpm docker:recreate
```

The container writes job data to `/app/workspace/jobs/:jobId`. Mount
`/app/workspace` if you want artifacts to survive container restarts. API
responses expose URLs and job-relative paths, not container absolute paths.

## Local Development

For non-Docker server development:

```bash
pnpm install
cp apps/server/config/model-provider.example.json apps/server/config/model-provider.json
pnpm run build
PORT=4310 pnpm run dev
```

Create a dry-run job without consuming model quota:

```bash
curl -F svg=@design.svg -F dryRun=1 http://127.0.0.1:4310/api/jobs
```

Build the SDK locally before consuming this repo through `file:`:

```bash
pnpm -C packages/client run build
```

## Configuration Reference

Server config lives under `apps/server`.

- `PORT`: service port, default `4310`.
- `WORKSPACE`: job workspace, default `apps/server/workspace` for local server commands.
- `MODEL_PROVIDER_CONFIG`: model config path, default `apps/server/config/model-provider.json` for local server commands.
- `OPENCODE_CLI_PATH`: opencode executable path, default `opencode`.
- `CHROMIUM_PATH`, `CHROME_PATH`, or `BROWSER_PATH`: optional browser override.
- `MAX_CONCURRENT_AGENTS`: max active jobs.
- `MAX_PARALLEL_MODULE_AGENTS`: per-job module concurrency.

Docker sets `WORKSPACE=/app/workspace` and
`MODEL_PROVIDER_CONFIG=/app/config/model-provider.json`.

## Release Notes

Publish a new Docker image by pushing a version tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Publish the SDK from `packages/client`:

```bash
npm publish --access public --registry https://registry.npmjs.org
```
