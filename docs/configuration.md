# Configuration

The server reads `apps/server/.env` during local commands. Existing process
environment values take precedence. Docker deployments should pass an env file
and mount the model provider JSON separately.

## Core Runtime

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4310` | HTTP listen port |
| `WORKSPACE` | `workspace` | Job and artifact root |
| `MODEL_PROVIDER_CONFIG` | `config/model-provider.json` | Model definition file |
| `OPENCODE_CLI_PATH` | `opencode` | Agent runtime executable |
| `FLUTTER_BIN` | `flutter` | Flutter executable for Flutter output |

Relative paths resolve from `apps/server` when commands are run through the
root package scripts. The provider config refers to secrets through
`apiKeyEnv`; put the actual secret in the environment.

## Concurrency

| Variable | Default |
| --- | ---: |
| `MAX_CONCURRENT_AGENTS` | `2` |
| `MAX_PARALLEL_MODULE_AGENTS` | `5` |
| `SEMANTIC_VISION_CONCURRENCY` | `3` (legacy alias for global vision limit) |
| `GLOBAL_MODEL_CONCURRENCY` | `10` |
| `GLOBAL_VISION_CONCURRENCY` | `3` |
| `GLOBAL_BUILD_CONCURRENCY` | `2` |
| `GLOBAL_REFERENCE_CONCURRENCY` | `1` |
| `MODULE_AGENT_TIMEOUT_MS` | `3600000` |
| `MODULE_AGENT_COORDINATOR_ENABLED` | `true` |
| `MODULE_AGENT_COORDINATOR_NODE_THRESHOLD` | `50` |
| `MODULE_AGENT_COORDINATOR_JSON_BYTES` | `35840` |

The private `GET /api/queue/settings` endpoint returns `{ revision, maxConcurrentJobs }`.
`PUT /api/queue/settings` accepts the same shape with a session limit from 1 through 32;
stale revisions return 409 and invalid values return 400. The gateway must authorize
administrator writes; do not expose Core directly to untrusted clients. Saves are
atomic and stored in workspace `queue-settings.json`. This runtime file overrides
`MAX_CONCURRENT_AGENTS` after the first save and must be included in runtime backups,
never in source snapshots. Increasing the limit fills available slots immediately.
Decreasing it leaves active sessions running and waits for enough slots to drain.
Per-session module concurrency is unchanged.

## Browser And Verification

`CHROMIUM_PATH`, `CHROME_PATH`, and `BROWSER_PATH` may point to a compatible
browser. The first available configured or detected browser is used.

| Variable | Default |
| --- | ---: |
| `CDP_OPERATION_CONCURRENCY` | `1` |
| `CDP_READY_TIMEOUT_MS` | `60000` |
| `CDP_SEND_TIMEOUT_MS` | `120000` |
| `BROWSER_POOL_DISABLED` | `false` |
| `BROWSER_POOL_IDLE_MS` | `1000` |
| `STATIC_SERVER_POOL_DISABLED` | `false` |
| `STATIC_SERVER_POOL_IDLE_MS` | `1000` |
| `DIFF_RATIO_THRESHOLD` | `0.05` |
| `MODULE_DIFF_RATIO_THRESHOLD` | `0.05` |
| `PNG_RASTER_SCALE_MULTIPLIER` | `2` |
| `QUALITY_POLICY` | `report` |
| `VERIFY_CACHE_DISABLED` | `0` |

## Model And Workflow

| Variable | Default |
| --- | --- |
| `DEFAULT_AGENT_REASONING_EFFORT` | `high` |
| `AGENT_UNIT_REASONING_EFFORT` | `high` |
| `SUPPORT_AGENT_REASONING_EFFORT` | `high` |
| `VISION_MODEL_REASONING_EFFORT` | `medium` |
| `VISION_TEXT_TIMEOUT_MS` | `300000` |
| `MODEL_PLANNER_TURN_TIMEOUT_MS` | `600000` |
| `WORKFLOW_ARCHIVE_FULL_EVERY_N` | `5` |
| `WORKFLOW_ARCHIVE_TEXT_MAX_CHARS` | `12000` |

Reasoning effort accepts `none`, `minimal`, `low`, `medium`, `high`, or
`xhigh`. `MODEL_PLANNER_MOCK_RESPONSE` is available for controlled local tests
and should not be set in production.

Image recognition uses `VISION_MODEL_REASONING_EFFORT` independently of
`SUPPORT_AGENT_REASONING_EFFORT`. The recognition call explicitly applies this
setting (default `medium`); module planning and generation retain their own
reasoning settings (default `high`).

All model calls share the policy in `pipeline/model-retry.ts`: one initial
attempt plus five retries by default, waiting a fixed 10 seconds before each retry.
This covers text/vision calls, module planning, streamed module generation and
user revisions. Network, TLS/certificate, rate-limit, HTTP 408/425/429 and 5xx
failures are retried. Empty or invalid structured responses use the same budget.
Invalid credentials, unsupported requests/configuration, local file errors and
user cancellation stop immediately. Existing session/module deadlines remain
in force, and cancellation interrupts backoff without starting another call.

Nested calls share the outer operation's budget, so transport retries and
response corrections cannot multiply each other. Module generation resumes the
existing conversation after network failures; encrypted-history failures rebuild
the conversation from current files and preserve user instructions. Failed
processes are drained before retrying. Retry notices appear in the job log.

The planner's `--planner-retries` option overrides the shared default for that
operation, including transport errors and response corrections; `0` disables
retries. `MODEL_PLANNER_TURN_TIMEOUT_MS` bounds the complete operation. Each
response, validation and transport failure is retained under
`artifacts/modules/planner-history`. Semantic recognition no longer recursively
resubmits failed sheets at smaller batch sizes; after its retry budget is spent,
it retains the existing visual-asset fallback.

Concurrency values must be integers from 1 to 128. Global pools apply across
jobs in one server process. Separate CLI processes and nested runtime agents
are not a distributed quota; use container CPU/memory limits and provider rate
limits for deployment-wide control. Reference capture remains serial by default.

`QUALITY_POLICY=report` preserves the existing `completed` execution status and
returns `result.quality` separately. `best-effort` returns that status when
visual checks fail; `strict` returns `failed-gate`. Structural/build/input
failures remain failures. Regional and DOM-text diagnostics are advisory,
especially for split text runs, outlined text and Flutter canvas output.

`VERIFY_CACHE_DISABLED=1` forces fresh local verification. Cache keys include
module source/assets, shared layers, relevant render options and package/model
configuration. Final page verification always runs. Stage durations are exposed
in `result.stageTimings` in milliseconds; model token usage is recorded separately.

SVG uploads are parsed before acceptance. DTDs and malformed XML are rejected;
absolute CSS units and scientific notation are supported. The service retains
its viewBox-based design-coordinate convention. Defaults limit uploads to
100,000 XML elements, 40 million screenshot pixels and a 32,768-pixel edge,
including the requested scale and screenshot device scale. Relative dimensions
without a valid viewBox are rejected.

## Session And Logging

The complete, copyable set of session, archive, logging, and telemetry limits
is maintained in `apps/server/.env.example`. Zero disables retention for limits
that use a non-negative parser. Boolean values accept `1/0`, `true/false`,
`yes/no`, or `on/off`.

## Docker Helper

The local helper treats `PORT` as the host port and always keeps the container
listen port at `4310`. `SVG_TRANSFORM_CORE_BIND_ADDRESS` defaults to
`127.0.0.1`. Other helper-only variables are documented by:

```bash
bash scripts/docker-core.sh --help
```

## Recovery, delivery, and runtime boundaries

Accepted jobs are persisted before enqueueing. Snapshots are coalesced, written
through a temporary file, synced and renamed. SIGTERM/SIGINT stop dispatch,
cancel/drain active work, requeue interrupted jobs and flush writes (30-second
shutdown deadline). Give the container at least 35 seconds to stop.

`RECOVER_INTERRUPTED_JOBS=0` disables automatic restart recovery. By default,
queued/running snapshots are restored to the queue. Valid preflight artifacts
and completed module checkpoints are reused; changed inputs invalidate them.
Unacknowledged repair instructions are retried at least once after interruption.
This is single-process recovery, not a multi-replica job queue.

`GET /health` checks process liveness. `GET /ready` checks the writable workspace,
browser, agent executable and default model configuration without making a
model request. Flutter availability is reported as a separate capability;
Flutter jobs require it before analysis. Readiness does not certify provider
connectivity or authenticate against the provider.

The image now runs as `node` (uid/gid 1000). On Linux, existing bind-mounted
workspaces must be writable by that uid. Provision a correctly owned directory
or choose an explicit container user appropriate for your deployment.

Agent subprocesses inherit an environment allowlist plus only their selected
provider credential/configuration. Additional required environment variables can
be named in `AGENT_ENV_ALLOWLIST` (comma-separated). External-directory tools
are limited to declared directories and the CLI installation directory;
`AGENT_EXTERNAL_DIRECTORY_POLICY=allow` restores the previous tool policy.
Tool permissions are not an OS sandbox: shell commands still run with the
container user's permissions. Use separate containers/workspaces for untrusted
tenants; authentication and tenant isolation remain outside this core service.

`GET /api/jobs/:id/download` now returns the immutable final deliverable ZIP.
`?kind=diagnostic` downloads runtime analysis/history instead. Existing jobs
without a deliverable can still use the diagnostic download; rerun them to
produce a final package. Deliverables contain a checksum manifest, quality
report and run instructions. React/Vue include an editable Vite project;
Flutter includes source and compiled web output. External asset URLs are
listed in the manifest and remain network dependencies.

SSE clients receive a fresh `init` snapshot after reconnecting; consumers should
replace their snapshot rather than assume replay of every transient event.
Status updates are coalesced over 100 ms. Slow connections are closed when their
write buffer exceeds 1 MiB so clients can reconnect and resynchronize.
