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
| `SEMANTIC_VISION_CONCURRENCY` | `min(MAX_PARALLEL_MODULE_AGENTS, 3)` |
| `MODULE_AGENT_TIMEOUT_MS` | `3600000` |
| `MODULE_AGENT_COORDINATOR_ENABLED` | `true` |
| `MODULE_AGENT_COORDINATOR_NODE_THRESHOLD` | `50` |
| `MODULE_AGENT_COORDINATOR_JSON_BYTES` | `35840` |

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

## Model And Workflow

| Variable | Default |
| --- | --- |
| `DEFAULT_AGENT_REASONING_EFFORT` | `high` |
| `AGENT_UNIT_REASONING_EFFORT` | `high` |
| `SUPPORT_AGENT_REASONING_EFFORT` | `high` |
| `VISION_TEXT_TIMEOUT_MS` | `300000` |
| `MODEL_PLANNER_TURN_TIMEOUT_MS` | `600000` |
| `WORKFLOW_ARCHIVE_FULL_EVERY_N` | `5` |
| `WORKFLOW_ARCHIVE_TEXT_MAX_CHARS` | `12000` |

Reasoning effort accepts `none`, `minimal`, `low`, `medium`, `high`, or
`xhigh`. `MODEL_PLANNER_MOCK_RESPONSE` is available for controlled local tests
and should not be set in production.

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
