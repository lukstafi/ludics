# Extract `buildHandlers(deps)` factory from `startDashboardServer`

## Goal

Make dashboard HTTP handlers testable without binding a port. PR #389 added the
first HTTP integration tests for `dashboard-server`, but they have to swap out
`console.error` and bind `port: 0` to keep the boot banner and listener
out of the way. Splitting the handler dispatch into a pure
`buildHandlers(deps): (req: Request) => Promise<Response>` factory lets future
tests call the handler directly with `await handler(new Request(...))` — no
socket, no banner, no swap-and-restore — and keeps `startDashboardServer` as a
thin `Bun.serve` wrapper for production callers.

Source: retrospective of `task-cf3ef9f1` (PR #389), `suggestRefactorSummary`
item 2.

## Acceptance Criteria

- `src/dashboard-server.ts` exports a new `buildHandlers(deps)` function whose
  return value is a `(req: Request) => Promise<Response>` dispatcher equivalent
  to today's inline `fetch` body. The dispatcher owns its own `lastGenerated`
  counter (one per factory call, isolated between callers).
- `startDashboardServer(port, dashboardDir, ttlSeconds)` is preserved as a
  public export, returns the same `Bun.serve` instance type as today, and still
  emits the three-line boot banner. Internally it delegates to
  `Bun.serve({ port, fetch: buildHandlers({ ... }) })`.
- The existing production caller in `src/dashboard.ts` (`dashboardServe`)
  keeps working unchanged — no signature change visible at the call site.
- The HTTP integration tests in `src/dashboard.test.ts`
  (`describe("dashboard HTTP /api/queue-promote and /api/queue-cancel", ...)`)
  are migrated to call `buildHandlers` directly. After migration:
  - The local `startServer()` helper inside that describe block is gone (or
    replaced by a trivial `buildHandlers(...)` call).
  - No port-0 `Bun.serve`, no `silenceConsoleError` wrap, no `server.stop(true)`
    teardown for these tests.
  - Tests construct fully-qualified `Request` objects (e.g.
    `new Request("http://x/api/queue-promote?id=...", { method: "POST" })`) and
    `await` the dispatcher.
- Behavior is unchanged: every migrated test passes with the same assertions
  against the same response shapes, and `bun run typecheck && bun run lint &&
  bun run build && bun test` is green.
- Pure refactor: no API/route additions, no behavioral changes, no edits to
  `cluster-http.ts` or other consumers.

## Context

How things work now (all in `src/dashboard-server.ts`):

- `startDashboardServer(port, dashboardDir, ttlSeconds)` is the single export.
  It declares closure state (`resolvedRoot`, `tasksRoot`, `homeRoot`,
  `lastGenerated`) and several nested helpers (`isSafeRegularFile`,
  `readDashboardTaskInfo`, `candidateProjectDirs`, `resolveProposalFile`,
  `resolveTaskFile`, `maybeRegenerate`), then constructs `Bun.serve({ port,
  fetch })`. After `Bun.serve`, three `console.error` lines emit the boot
  banner and the function returns the server.
- The `fetch` body reads only the closure names listed above plus
  module-level imports (`slotClear`, `queueRequest`, `harnessDir`,
  `loadConfigSync`, `tasksAbandon`, `handleClusterRequest`, `MIME_TYPES`,
  `TASK_ID_RE`, `QUEUE_ID_RE`, etc.). Module-level imports do not need to be
  threaded through `deps`.
- `lastGenerated` is *per-server*, mutable — read by `maybeRegenerate` and
  reset to `0` by ~10 endpoints. It must live inside `buildHandlers` so each
  factory call gets its own counter and tests don't leak state.
- `homeRoot` snapshots `process.env.HOME` at construction time. Today's test
  helper builds the server *after* `beforeEach` mutates `HOME`, so calling
  `buildHandlers` at the same point preserves identical behavior.
- `loadConfigSync()` and `harnessDir()` are called lazily inside handlers and
  read env on each call — no change needed.
- The boot banner (`console.error` x3) is the only lifecycle side-effect tied
  to opening a port. It belongs in `startDashboardServer`, not in
  `buildHandlers`.
- Consumers of `startDashboardServer` outside the test file: only
  `src/dashboard.ts`'s `dashboardServe`, which discards the return value
  today. No other production callers.
- Test-side: `src/dashboard.test.ts` `describe("dashboard HTTP
  /api/queue-promote and /api/queue-cancel", ...)` defines a local
  `startServer()` helper that wraps `startDashboardServer(0, dashboardDir,
  3600)` in `silenceConsoleError` and returns `{ baseUrl, stop }`. The tests
  in that block construct absolute URLs against `baseUrl` and call `fetch()`.
  `silenceConsoleError` lives in `src/test-utils.ts`; it stays available for
  other call sites.
- Other tests in `dashboard.test.ts` already exercise pure functions
  (`dashboardGenerate`, `computeSlotLiveness`, `taskLink`, `proposalLink`,
  slot-JSON shape). They are unaffected.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The refactor is mostly textual; this approach reflects the elaboration's
Tentative Design which the user has reviewed:

1. In `src/dashboard-server.ts`, declare an interface
   `DashboardHandlerDeps { dashboardDir: string; ttlSeconds: number }` and a
   new exported `buildHandlers(deps: DashboardHandlerDeps): (req: Request) =>
   Promise<Response>`. Move the existing closure state, nested helpers, and
   `fetch` body inside `buildHandlers`; have it return the inner async
   function directly.
2. Reduce `startDashboardServer` to:
   ```ts
   export function startDashboardServer(
     port: number,
     dashboardDir: string,
     ttlSeconds: number,
   ): ReturnType<typeof Bun.serve> {
     const server = Bun.serve({
       port,
       fetch: buildHandlers({ dashboardDir, ttlSeconds }),
     });
     console.error(`ludics: dashboard server listening on http://localhost:${server.port}`);
     console.error(`ludics: data regenerates lazily (TTL: ${ttlSeconds}s)`);
     console.error("ludics: press Ctrl+C to stop");
     return server;
   }
   ```
3. In `src/dashboard.test.ts`, replace the `startServer()` helper inside the
   HTTP describe block with a direct `buildHandlers` call (a tiny helper that
   returns the dispatcher is fine if it reduces churn). Each test then does:
   ```ts
   const { buildHandlers } = await import("./dashboard-server.ts");
   const handler = buildHandlers({ dashboardDir, ttlSeconds: 3600 });
   const resp = await handler(new Request(`http://x/api/queue-promote?id=${idC}`, { method: "POST" }));
   ```
   Drop `silenceConsoleError`, `baseUrl`, `server.stop(true)`, and the
   `try/finally` teardown for these tests. The `dashboardDir` directory must
   still exist on disk (the static-file fallback reads it); existing
   `mkdirSync` calls cover that.
4. Run `bun run typecheck && bun run lint && bun run build && bun test`.

Notes the implementer should keep in mind:
- The handler signature must accept `Request` (not bare URL strings) and
  return `Promise<Response>` — Bun rejects bare paths so tests must use
  fully-qualified URLs (any host works; only `url.pathname` is inspected).
- `silenceConsoleError` stays in `src/test-utils.ts` for other call sites
  (used by `dashboardGenerate` tests). Only the calls inside the migrated
  describe block go away.
- `canBindSocket` from `test-utils.ts` is unused after migration but does not
  need to be deleted — leave it for any future test that genuinely needs a
  socket.

## Scope

**In scope:**
- `src/dashboard-server.ts` — extract `buildHandlers`, slim
  `startDashboardServer`.
- `src/dashboard.test.ts` — migrate the HTTP integration tests in the
  `describe("dashboard HTTP /api/queue-promote and /api/queue-cancel", ...)`
  block to call `buildHandlers` directly.

**Out of scope:**
- API or route additions; behavioral changes of any kind.
- Switching server frameworks.
- Extracting the `TTL=3600` constant from the production path (the
  retrospective mentions it but treats it as informational, not a bug).
- Removing `silenceConsoleError` or `canBindSocket` from `src/test-utils.ts`
  — they have other consumers.

**Dependencies:**
- Relates to `task-cf3ef9f1` (PR #389) — that PR added the integration tests
  whose port-0 + console-silencing boilerplate this refactor lets us drop. No
  blocking dependency; PR #389 is already merged.
