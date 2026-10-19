# Contributing

## Prerequisites

- Node.js 22.16.x (see `.node-version`)
- pnpm 10.11.x (see the root `packageManager` field)
- A Chromium-compatible browser for render verification
- Flutter on `PATH`, or `FLUTTER_BIN`, only when developing Flutter output

## Setup

```bash
pnpm install --frozen-lockfile
cp apps/server/config/model-provider.example.json apps/server/config/model-provider.json
pnpm build
```

Keep credentials in `apps/server/.env` or a Docker env file. Never put API keys
in the model provider JSON or commit either local runtime file.

## Development

```bash
pnpm dev
```

The development command runs TypeScript directly. `pnpm start` is the
production-mode entry and requires `pnpm build` first.

The render regression test needs Chrome/Chromium even when the real Flutter
smoke test is disabled. If no supported system browser is installed, use the
Playwright version pinned by the lockfile:

```bash
pnpm -C apps/server exec playwright install chromium
export CHROMIUM_PATH="$(pnpm -C apps/server exec node --input-type=module -e 'import { chromium } from "playwright"; console.log(chromium.executablePath())')"
```

On Linux, use `playwright install --with-deps chromium` to install its system
libraries too. CI explicitly installs this browser and sets `CHROMIUM_PATH`.

Useful checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
pnpm check
```

`pnpm check` is the required pre-commit quality gate. It uses the same sequence
as CI: release metadata, lint, source/test typechecking, clean compilation,
tests, and SDK tarball verification. Each package is built once; tests and
packaging then reuse that output. It does not require model credentials or
consume model quota. The real Flutter smoke test remains opt-in because it
requires a local Flutter SDK.

`pnpm test`, `pnpm build`, and `pnpm check:package` remain standalone commands;
the latter rebuilds the SDK before checking it. `build:compile`, `test:run`,
and `check:package:built` are lower-level steps used by the quality gate, with
typechecking or fresh build output supplied by earlier steps.

The package check creates a real tarball, enforces its file allowlist, runs
publint, installs it in a temporary consumer without lifecycle scripts or
network access, and compiles/runs a TypeScript smoke test through the public
package name. Temporary files are removed on success or failure. When adding
intentional SDK distribution files, update the allowlist in
`scripts/check-package.mjs`. CI also runs this check on Node.js 20.19.0, the
SDK's minimum supported Node version.

## Change Guidelines

- Keep API DTOs and the client SDK types synchronized.
- Add focused tests for observable behavior changes and regression fixes.
- Keep generated jobs, runtime traces, credentials, browser reports, coverage,
  and build output out of Git.
- Avoid mixing mechanical formatting with behavioral changes.
- Run `git diff --check` before submitting a change.

## Releases

All workspace package versions must match. Update them to the next unused
SemVer before creating a release tag, then run:

```bash
VERSION=$(node -p "require('./package.json').version")
RELEASE_TAG="v$VERSION" pnpm check:release
pnpm check
```

The tag workflow validates the repository again before publishing the Docker
image. The client package rebuilds automatically during `prepack`.
