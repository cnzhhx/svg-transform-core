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

Useful checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
pnpm check
```

`pnpm check` is the required pre-commit quality gate. It uses the same sequence
as CI and does not require model credentials or consume model quota. The real
Flutter smoke test remains opt-in because it requires a local Flutter SDK.

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
