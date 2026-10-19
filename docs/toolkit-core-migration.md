# Toolkit conversion improvements

Migration date: 2026-10-19. The source is toolkit's `codex/dev-20261015`
branch at `21d749b`, covering changes made during October 12–18.

## Changes

| Source | Conversion behavior |
| --- | --- |
| `5ef6a1d` | Module recovery, fresh conversations for invalid encrypted history, and reuse of files already written |
| `febb968`, `640392f` | Disposable-page CDP retries, interruption of stalled JavaScript, and bounded target cleanup |
| `640392f`, `11d1e82` | Full text-style inference with reusable raster surfaces and precomputed color distances |
| `4081efb` | Mixed SVG text preservation, native line geometry, child-span deduplication, and scaled paint matching |
| `d336e5d`, `05c3dbf` | Existing Core process draining and per-job model isolation are retained and covered by regressions |

The migration preserves the current HTTP/SDK contracts and HTML, Vue, React,
and Flutter outputs. Core keeps its existing model configuration and portable
font fallback. The migrated tests use synthetic SVGs and offline model fixtures.

## Core adaptations

- Module retries allow five additional attempts, separated by five seconds.
  Network failures, rate limits and temporary server failures can recover.
  Explicit authentication, parameter and configuration errors fail immediately.
  Structured upstream error names, codes and HTTP statuses survive CLI failures.
- Invalid encrypted history starts a new conversation using the latest files,
  revision and guidance. The obsolete persisted conversation ID is cleared;
  the replacement ID is persisted as soon as the runtime reports it.
- CDP retries recreate the whole target and release their concurrency slot
  before exponential backoff. Callers can set `maxRetries` and `signal`.
  Cancellation propagates through session and verification scopes, including
  queued operations and retry delays. Active file leases renew every 60 seconds.
- Text inference processes every input block in one evaluation, with a
  300-second evaluation budget and two retries. Empty inputs return directly.
- Cropping version 7, node-fact version 6, semantic-pass version 8 and paint
  stage v3 invalidate outdated preprocessing. Conversion cache version 2 also
  invalidates old preflight, completed-module, verification and candidate keys.
  Caches refresh when a job is next executed or revised; workspace data is kept.
- Semantic freshness checks compare source content, geometry, scale, effective
  vision configuration and conversion versions. Compact agent inputs are checked
  against the full debug document. Reusing full preprocessing preserves the
  current generated-asset registrations, including valid empty text results.

## Validation

`pnpm check` passed after migration: release consistency, lint, typechecking,
server/client compilation, the MCP entrypoint, 88 server tests, seven SDK tests,
and the isolated SDK package consumer. One real-Flutter test was skipped because
the Flutter SDK was unavailable. Real Chromium regressions executed successfully;
no paid model endpoint was called.

The normal `pnpm check` entrypoint includes the migrated protocol fixtures,
real Chromium timeout recovery, SVG preprocessing at 1x and 2x, Unicode and
whitespace preservation, cache invalidation, and module-thread recovery tests.
Model execution uses offline fixtures. The existing Flutter SDK check remains
conditional on a locally available SDK.

The text inference benchmark generates 48 synthetic text blocks and alternates
two baseline and two optimized runs after warmup. Both versions use the same
browser adapter and fonts; all declarations and numerical fit values are
compared. On the local Node.js 22.16.0 run:

| Measurement | Result |
| --- | ---: |
| Previous inference, mean | 3984.49 ms |
| Optimized inference, mean | 797.77 ms |
| Speedup of this inference step | 4.99x |
| Blocks compared | 48 |
| Declaration differences | 0 |
| Maximum fit-value difference | 0 |

These timings measure text inference on the synthetic fixture. They do not
measure total conversion latency or a hosted model's visual quality.

To repeat the comparison, supply a saved pre-migration Core inference source:

```bash
pnpm -C apps/server exec node --import tsx scripts/benchmark-text-inference.mjs \
  /absolute/path/to/previous/text-style-inference.ts
```

The benchmark compiles that baseline in memory and removes its temporary raster
fixture when finished. It does not call a model endpoint.
