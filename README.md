# svg-transform-core

Core SVG transform service plus a lightweight HTTP client SDK.

Published artifacts:

- Docker image: `ghcr.io/cnzhhx/svg-transform-core:0.2.2`
- npm SDK: `@svg-transform/core-client`

The service is intentionally core-only. It does not include account systems,
billing, quotas, orders, tenant rules, or a business frontend.

Runtime behavior and migration notes for quality policies, restart recovery,
immutable deliverables, SSE reconnection, and non-root containers are documented
in [configuration](docs/configuration.md#recovery-delivery-and-runtime-boundaries).

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
  -p 127.0.0.1:4310:4310 \
  --env-file .runtime/core.env \
  -e MAX_CONCURRENT_AGENTS=2 \
  -e MAX_PARALLEL_MODULE_AGENTS=5 \
  -v "$PWD/workspace:/app/workspace" \
  -v "$PWD/.runtime/model-provider.json:/app/config/model-provider.json:ro" \
  ghcr.io/cnzhhx/svg-transform-core:0.2.2
```

The service has no built-in authentication. Keep the default loopback binding
for local use. Put it behind an authenticated reverse proxy before exposing it
to another machine or the public internet.

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

Non-dry-run uploads are queued automatically. If the job was created with
`dryRun=1`, start the returned `jobId` explicitly:

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

Supported `outputFormat` values are `html`, `vue`, `react`, and `flutter`.

Flutter output is a complete project beside the uploaded SVG, with the entry at
`<design>.flutter/lib/main.dart`. The service builds that project with Flutter
Web and uses the compiled result for the same browser screenshot and pixel-diff
verification as the other formats. A Flutter SDK must be available on `PATH`,
or `FLUTTER_BIN` must point to its executable. The service reports a clear build
error when Flutter is unavailable; it never substitutes the HTML preview for a
Flutter render.

The published base image does not bundle the large Flutter SDK. Build a derived
image with Flutter on `PATH` when containerized Flutter output is required.

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
docker pull ghcr.io/cnzhhx/svg-transform-core:0.2.2
```

The `latest` tag is also updated on stable version releases:

```bash
docker pull ghcr.io/cnzhhx/svg-transform-core:latest
```

If you are working inside this repository, the local helper can manage the
container:

```bash
mkdir -p .runtime
cp apps/server/config/model-provider.example.json .runtime/model-provider.json
SVG_TRANSFORM_CORE_IMAGE=ghcr.io/cnzhhx/svg-transform-core:0.2.2 pnpm docker:recreate
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

Use Node.js `22.16.x` and pnpm `10.11.x`; `.node-version` and `packageManager`
encode those repository tool versions.

For non-Docker server development:

```bash
pnpm install --frozen-lockfile
cp apps/server/config/model-provider.example.json apps/server/config/model-provider.json
pnpm run build
PORT=4310 pnpm run dev
```

Run the complete local quality gate before opening a pull request:

```bash
pnpm check
```

This checks release metadata, lint, strict TypeScript settings, production
builds, all workspace tests, and the SDK tarball installed in an isolated
consumer (including public exports and types). Each package is built once
during this check. See `CONTRIBUTING.md` for browser setup and individual
commands, and `docs/configuration.md` for all environment options.

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
- `FLUTTER_BIN`: Flutter executable used for `flutter` output, default `flutter` on `PATH`.
- `CHROMIUM_PATH`, `CHROME_PATH`, or `BROWSER_PATH`: optional browser override.
- `MAX_CONCURRENT_AGENTS`: max active jobs.
- `MAX_PARALLEL_MODULE_AGENTS`: per-job module concurrency.

Docker sets `WORKSPACE=/app/workspace` and
`MODEL_PROVIDER_CONFIG=/app/config/model-provider.json`.

## Release Notes

Set all three package versions to the next unused SemVer, keep them in sync,
run the release check, then push the matching version tag. The tag workflow
repeats the full quality gate before it publishes:

```bash
VERSION=$(node -p "require('./package.json').version")
RELEASE_TAG="v$VERSION" pnpm check:release
git tag "v$VERSION"
git push origin "v$VERSION"
```

Publish the SDK from `packages/client`. Its `prepack` hook always rebuilds
`dist` so ignored or stale local output cannot be published:

```bash
pnpm -C packages/client publish --access public --registry https://registry.npmjs.org
```
