# svg-transform-core

Core SVG transform runtime, packaged as a pnpm monorepo.

```text
apps/server/       # core service, Docker runs this app
packages/client/   # lightweight HTTP SDK, publishable later
```

The server intentionally contains no C-side product logic: no account system, billing, quota, orders, tenant rules, or business frontend.

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

## Local Development

For non-Docker server development only:

```bash
pnpm install
cp apps/server/config/model-provider.example.json apps/server/config/model-provider.json
pnpm run build
PORT=4310 SESSION_CHAT_DISABLED=0 pnpm run dev
```

Create a dry-run job without consuming model quota:

```bash
curl -F svg=@example.svg -F dryRun=1 http://127.0.0.1:4310/api/jobs
```

Create a real job:

```bash
curl -F svg=@example.svg -F outputFormat=html -F scale=1 http://127.0.0.1:4310/api/jobs
```

Send a repair instruction:

```bash
curl -H 'Content-Type: application/json' \
  -d '{"moduleId":"module-001","text":"Make this module closer to the source SVG."}' \
  http://127.0.0.1:4310/api/jobs/<jobId>/messages
```

## Client SDK

`packages/client` builds `@svg-transform/core-client`. It wraps only the public HTTP API and does not include server pipeline, browser, model, Docker, or business logic.

```ts
import { createSvgTransformClient } from "@svg-transform/core-client";

const client = createSvgTransformClient({
  baseUrl: "http://127.0.0.1:4310",
});

const job = await client.createJob(file, { outputFormat: "html" });
await client.startJob(job.jobId);
```

Build it locally before a project consumes this repo through `file:`:

```bash
pnpm -C packages/client run build
```

## Docker

```bash
cp docker-compose.yml.example docker-compose.yml
mkdir -p .runtime
cp apps/server/config/model-provider.example.json .runtime/model-provider.json
docker compose up --build
```

For local one-command container management:

```bash
mkdir -p .runtime
cp apps/server/config/model-provider.example.json .runtime/model-provider.json
pnpm docker:start
```

Useful commands:

```bash
pnpm docker:status
pnpm docker:logs
pnpm docker:health
pnpm docker:stop
pnpm docker:recreate
```

`docker:start` starts the existing container when it already exists. If you changed Docker env, port, volume, image, or model config path, use `pnpm docker:recreate` so Docker receives the new create-time settings.

Optional overrides:

```bash
PORT=4311 pnpm docker:recreate
SVG_TRANSFORM_CORE_ENV_FILE=apps/server/.env pnpm docker:recreate
SVG_TRANSFORM_CORE_MODEL_CONFIG=/absolute/path/model-provider.json pnpm docker:recreate
```

`model-provider.json` is a Docker runtime mount, not image content. By default
the helper mounts `./.runtime/model-provider.json` into the container as
`/app/config/model-provider.json`. External projects that only consume this
service should keep their own host-side config file and pass it with
`SVG_TRANSFORM_CORE_MODEL_CONFIG=/path/to/model-provider.json`.

Keep real API keys out of `model-provider.json` when possible. Use `apiKeyEnv`
in the JSON file, then pass the actual environment variable through Docker, for
example:

```bash
SVG_TRANSFORM_CORE_ENV_FILE=.runtime/core.env pnpm docker:recreate
```

The Dockerfile defaults to Tsinghua Debian mirrors and npmmirror for npm downloads. Override them when needed:

```bash
docker build \
  --build-arg DEBIAN_MIRROR=http://deb.debian.org/debian \
  --build-arg DEBIAN_SECURITY_MIRROR=http://security.debian.org/debian-security \
  --build-arg NPM_REGISTRY=https://registry.npmjs.org \
  -t svg-transform-core:local .
```

The container writes job data to `/app/workspace/jobs/:jobId`. Mount `/app/workspace` if you want artifacts to survive container restarts. API responses expose URLs and job-relative paths, not container absolute paths.

## Configuration

Server config lives under `apps/server`.

- `PORT`: service port, default `4310`.
- `WORKSPACE`: job workspace, default `apps/server/workspace` for local server commands.
- `MODEL_PROVIDER_CONFIG`: model config path, default `apps/server/config/model-provider.json` for local server commands.
- `OPENCODE_CLI_PATH`: opencode executable path, default `opencode`.
- `CHROMIUM_PATH`, `CHROME_PATH`, or `BROWSER_PATH`: optional browser override.
- `MAX_CONCURRENT_AGENTS`: max active jobs.
- `MAX_PARALLEL_MODULE_AGENTS`: per-job module concurrency.
- `SESSION_CHAT_DISABLED=0`: keep chat repair enabled.

Docker sets `WORKSPACE=/app/workspace` and `MODEL_PROVIDER_CONFIG=/app/config/model-provider.json`. The host-side default mount source is `./.runtime/model-provider.json`.
