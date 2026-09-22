# Architecture

## Workspace Layout

- `apps/server`: Express API, session lifecycle, transform pipeline, render and
  verification utilities, CLI tools, and the browser MCP entrypoint.
- `packages/client`: dependency-free HTTP and SSE client distributed on npm.
- `scripts`: repository and local Docker operations.
- `workspace`: ignored runtime state containing uploaded designs and job output.

## Request Flow

1. `routes/jobs.ts` validates an SVG upload and creates a persisted session.
2. `pipeline/agent-runner` queues the session, plans modules, and coordinates
   generation and local verification.
3. `pipeline/module-merge` combines module output into the selected HTML, Vue,
   React, or Flutter target.
4. `core/render.ts` and `core/diff` render and compare the result.
5. `session-store` persists snapshots and emits events consumed by the SSE
   route and client SDK.

Non-dry-run jobs enter the queue during creation. Dry-run jobs remain drafts
until the start endpoint is called.

## Build Boundaries

The server has two execution modes:

- `pnpm dev` uses `tsx` for local iteration.
- `pnpm build` typechecks source and tests, compiles all server source to
  `apps/server/dist`, and creates the MCP compatibility entrypoint.
- `pnpm start` and the Docker image execute `dist/server.js`.

Runtime agent prompts still invoke selected TypeScript CLI tools through `tsx`,
so `tsx` is intentionally a production dependency.

The client build emits JavaScript and declarations to `packages/client/dist`.
That directory is ignored by Git and rebuilt by the package `prepack` hook.
Both packages use `noEmitOnError` to prevent emission when compilation fails.

The repository quality gate typechecks first, then runs each package's clean
`build:compile` step once. `test:run` and `check:package:built` consume that
output without rebuilding it. The standalone build, test, and package-check
commands still prepare their own prerequisites. Package verification installs
the SDK tarball outside the workspace to catch files or exports that work only
through local workspace resolution.

## Runtime Data

Each job owns a directory below `WORKSPACE`. Public API responses expose only
job-relative paths and URLs. Model credentials stay in environment variables;
the model provider JSON stores only the name of the credential variable.

The server and SDK are core infrastructure. Authentication, billing, quotas,
tenant isolation, and a business UI belong outside this repository.
