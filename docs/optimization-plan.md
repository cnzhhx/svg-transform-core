# Pipeline reliability and optimization plan

Approved scope: all fourteen recommendations from the project review.

## Execution sequence

1. Input and execution correctness (review items 1, 5, 7, 13)
   - Validate SVG dimensions and input budgets before enqueueing.
   - Drain failed concurrent work, propagate cancellation, preserve validation failures.
   - Expose quality independently of execution status, with configurable enforcement.
   - Add deterministic regression tests for these behaviors.
2. Planning, resource scheduling, caching, and iteration (2, 3, 4, 6, 8, 9)
   - Use one planner retry budget with attempt history.
   - Validate concurrency settings and introduce shared resource limits.
   - Pipeline reference preparation, record stage timings, fingerprint reusable artifacts.
   - Preserve validated candidates and publish regional/text diagnostics.
3. Persistence and recovery (12)
   - Await durable acceptance, coalesce snapshots, drain writes on shutdown.
   - Recover queued/interrupted work and reuse valid completed module outputs.
4. Delivery and API client (10, 11)
   - Separate immutable deliverables from diagnostic archives.
   - Align event contracts, bound streaming backpressure, reconnect and resync clients.
   - Support request cancellation and timeouts.
5. Runtime and release verification (13, 14)
   - Add readiness checks, restrict agent environment/permissions, non-root container.
   - Add deterministic SVG fixtures and independent exported-project checks.
   - Run repository checks, document configuration and remaining environment limits.

## Compatibility decisions

- Existing `completed` behavior remains the default; quality is exposed separately.
- Quality enforcement, recovery, and resource budgets are explicit configuration.
- User-directed revisions are not automatically rolled back on visual score alone.
- Local and CI validation does not invoke paid model endpoints.
- Live provider benchmarks and real Flutter validation require the corresponding runtime.

## Progress

- [x] Phase 1
- [x] Phase 2
- [x] Phase 3
- [x] Phase 4
- [x] Phase 5

## Implementation map

| Review item | Implementation |
| --- | --- |
| 1 Input | SAX XML validation, CSS absolute units/exponents, node/pixel/edge budgets before acceptance; shared length parser for cropping |
| 2 Planning | Single bounded attempt loop, transient-error backoff, task cancellation, per-attempt history |
| 3 Semantics | Content/configuration fingerprints for semantic/reference/context artifacts; empty text results are valid cached results |
| 4 Resources | Process-wide model/vision/build/reference pools, abortable waiters, pipelined reference preparation, stage durations |
| 5 Failure lifecycle | Stop dispatch on failure, drain workers, isolate preparation errors, terminate abandoned runtime streams and clean credentials |
| 6 Best candidate | Preserve complete source/assets with score and reference context, restore only for unguided initial generation, reverify restored output |
| 7 Quality | Preserve local failures until checks pass, always verify final module artifacts, separate API quality and configurable completion policy |
| 8 Diagnostics | 8×8 spatial diff distribution, maximum regional error, advisory DOM text missing/duplicate/offset checks |
| 9 Verification reuse | Content/configuration-keyed local HTML/framework verification with output existence checks; final full-page verify remains fresh |
| 10 Delivery | Versioned final ZIP, checksums, minimal referenced assets, editable React/Vue projects, Flutter source/build, separate diagnostic download |
| 11 SDK/SSE | Correct event fields/deletion type, CRLF/multiline parser, reconnect + snapshot resync, backpressure bound, timeouts/cancellation/auth headers |
| 12 Recovery | Durable acceptance, coalesced synced snapshots, shutdown draining, queue restoration, validated module checkpoints, guidance acknowledgement |
| 13 Regression | Offline planner/runtime fixtures, SVG corpus, API/cache/recovery tests, four-format exports, independent React/Vue installation/build CI |
| 14 Runtime | `/ready`, early runtime checks, environment allowlist and selected-provider config, directory tool policy, non-root image and deployment notes |

## Validation

- Repository checks cover lint, typechecking, source/MCP builds, server/client
  tests and installation of the published SDK tarball outside the workspace.
  Final `pnpm check` passed: 35 server tests passed, one real-Flutter test skipped,
  and seven SDK tests passed.
- Independent React and Vue exports were installed and built in fresh temporary
  directories using their own generated package manifests. This caught and
  fixed a macOS realpath/temporary-directory portability issue.
- The Docker image was built and run as uid 1000. Liveness, explicit not-ready
  response without configured credentials, dry-run upload persistence, browser
  rendering and SVG analysis/cropping passed in the container.
  The final image also passed offline runtime cleanup and HTTP API tests as a
  non-root user. The temporary smoke container shut down cleanly (exit 0) and
  was removed; the locally built validation image remains available.
- Production dependency audit against the public npm registry reported no high
  or critical vulnerabilities and two moderate vulnerabilities. The configured
  private registry does not support the audit endpoint.
- No real model endpoint was called. Deterministic fixtures validate lifecycle
  and contracts, not the visual quality/cost of a particular hosted model.
- Real Flutter SDK validation is skipped when Flutter is unavailable. Existing
  fake-SDK build/merge tests, Flutter packaging and delayed web-mount rendering
  remain covered.

## Operational notes

- Read `docs/configuration.md` before migrating Linux bind mounts: the image
  now runs as uid/gid 1000, and final versus diagnostic downloads are separate.
- Global pools coordinate one server process; nested agent/standalone CLI
  execution is not governed by a distributed provider quota.
- Directory tool permissions plus a non-root container reduce exposure but are
  not an OS sandbox for shell commands.
- Replayed repair instructions have at-least-once semantics after interruption.
  User-directed revisions are never automatically reverted based on diff alone.
