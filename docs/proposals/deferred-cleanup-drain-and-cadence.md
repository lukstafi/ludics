# Fix deferred-cleanup drain: resilient per-resource reaping + 4h health-check cadence

## Goal

`mag/cleanup-pending.json` (the deferred-cleanup queue) accumulated **360
entries going back to 2026-05-14** because the reaper never drains them. Orphan
tmux sessions, ttyd processes, worktrees, and branches from long-merged tasks
pile up indefinitely. Two independent defects keep eligible entries from ever
being reaped:

1. **Drain defect** — `processDeferredCleanups()` runs each past-grace entry
   through five sub-steps under a single shared `failed` flag, then re-queues
   the *whole* entry if *any* sub-step failed. The dominant driver is the
   t3code arm: it sets `failed = true` whenever the t3code server is not
   running, but t3code integration is **intentionally paused** (server down by
   design — gh-ludics-539). Every entry carrying `t3codeThreadIds` therefore
   re-queues on every tick and never drains. Benign worktree/branch no-ops
   (already removed / already deleted) pin entries the same way.

2. **Cadence defect** — the reaper is invoked from exactly one place,
   `briefingPrecomputeContext`, so it runs ~once per day. An entry that crosses
   the 25h grace window *after* the morning briefing waits roughly a full day
   before it is even attempted.

This fixes both so the queue drains, and the existing 360-entry backlog
self-drains over subsequent ticks.

Relates to: task-9a9e7989 and task-d2a16a60 (same family — hardening cleanup
against benign worktree/branch failures); gh-ludics-539 (t3code integration
feature flag / pause).

## Acceptance Criteria

- An entry whose only un-completable step is t3code thread deletion **while
  t3code integration is paused** (`t3codeIntegrationEnabled()` returns `false`)
  drains out of `cleanup-pending.json` instead of re-queueing forever. Its
  reapable resources (tmux / worktree / branch / peer-sync) are still cleaned;
  the t3code thread deletion is treated as a **skip, not a failure** (the
  threads die with the paused server, so skipping deletion is safe).

- Benign worktree/branch no-ops (worktree already removed, branch already
  deleted/merged) do not pin an entry in the queue indefinitely. An entry whose
  every reapable resource is already gone is dropped, not retained.

- A **genuinely retryable transient failure** still retains the entry. When
  t3code integration is **enabled** but the server is transiently unreachable,
  or a tmux kill fails for a reason other than "no server" / "session not
  found", the entry is kept for a future tick (subject to the bounded-retry
  ceiling below, if adopted).

- `processDeferredCleanups()` runs on the **4h health-check cadence** in
  addition to the existing briefing-precompute trigger, so reaping is evenly
  spaced (~6×/day) rather than once per day. The briefing call is preserved.

- The existing 360-entry backlog **drains naturally** over subsequent ticks
  once the fix ships (entry count drops on its own; **no manual purge or
  hand-edit** of `cleanup-pending.json`).

- Tests cover:
  - (a) a paused-t3code entry drains — its reapable work is done and the entry
    is removed even though it carries `t3codeThreadIds`;
  - (b) an entry with a genuinely-retryable transient failure (e.g. t3code
    *enabled* + server unreachable) is still retained;
  - (c) the health-check code path invokes the reaper;
  - (d) negative control — a within-grace entry is NOT reaped early.

- No regression in `src/orchestration/deferred-cleanup.test.ts`,
  `slots/slot-clear-integration.test.ts`, the t3code-paused gates, or
  `src/t3code/index.test.ts`.

## Context

How things work now (identifiers verified by grep on 2026-06-06; line numbers
omitted — they drift):

- **`processDeferredCleanups(thresholdHours?, harnessDir?)`** in
  `src/orchestration/deferred-cleanup.ts` is the reaper. It loads entries via
  `loadDeferredCleanups`, computes a `cutoff` from `cleanupDelayHours()`
  (default 25h, capped at 72h — `src/config.ts`), and for each past-cutoff
  entry runs five steps under one local `let failed = false`:
  1. **Worktrees** — `removeWorktreeByPath` per path, plus a best-effort
     `purgeOrphanDirIfRecoverable` fallback that deliberately does *not* set
     `failed`. A throw from `removeWorktreeByPath` sets `failed = true`.
  2. **Branches** — `deleteBranches(projectDir, branches)`; a throw sets
     `failed = true`.
  3. **Tmux** — `tmux kill-session` per name via `safeSyncOutput`; already
     tolerates `"no server running"` and `"session not found"` in stderr,
     else sets `failed = true`.
  4. **Peer-sync** — `removePeerSyncLink`; a throw sets `failed = true`.
  5. **t3code threads** — if `entry.t3codeThreadIds` is non-empty, imports
     `serverStatus`; **if the server is not running it logs "server not
     running, will retry" and sets `failed = true`**, otherwise dispatches
     `thread.session.stop` + `thread.delete` per thread.

  After the five steps: `if (failed) remaining.push(entry)` — the whole entry
  is retained. Finally `saveDeferredCleanups(remaining, harnessDir)`.

  The all-or-nothing `failed` flag is the core bug: a single un-completable
  sub-step (overwhelmingly the paused-t3code arm) holds the entry hostage even
  after every reapable resource has been cleaned.

- **`t3codeIntegrationEnabled()`** in `src/config.ts` is the in-process gate —
  returns `mag.t3code_integration_enabled === true` (strict opt-in; currently
  `false`/paused). The `ludics t3code integration-status` subcommand
  (`src/t3code/index.ts`) is just a thin CLI wrapper that prints
  `enabled`/`paused` from this same function. Prefer calling
  `t3codeIntegrationEnabled()` directly in-process rather than shelling out.

- **Reaper trigger (the one current call site):**
  `briefingPrecomputeContext` in `src/mag.ts` dynamically imports
  `processDeferredCleanups` and awaits it inside a `try/catch` that logs
  `"ludics: deferred cleanup failed:"` on error. This is the try/catch shape
  to mirror.

- **Health-check code path:** in `src/mag.ts`, the `action === "health-check"`
  branch (programmatic dispatch, gated by `shouldSkipHealthCheck` from
  `src/health-gate.ts`) is where the 4h launchd-driven health check runs its
  work — it already calls `runAllTestHealth()` from `src/health.ts` inside a
  `try/catch`, then head-inserts a `/compact`. This branch is the natural home
  for the second reaper call (it only runs when the gate does *not* skip, so it
  inherits the even ~4h spacing). The `/ludics-health-check` skill is the
  user-facing surface, but the actual periodic code runs here.

- **Tests:** `src/orchestration/deferred-cleanup.test.ts` already exercises
  `processDeferredCleanups(25)` with synthetic entries (empty resource arrays
  as no-op fixtures, past/future timestamps for partition tests) and has an
  orphan-dir hardening block (task-d2a16a60) and explicit-harness/ISO variants.
  New drain tests slot in here. `src/t3code/index.test.ts` covers the
  `integration-status` probe.

- **Live fixture:** `mag/cleanup-pending.json` in the harness holds the
  360-entry backlog. The April-dated entries are exactly the paused-t3code
  shape (`t3codeThreadIds: ["t-1"]`, empty `tmuxSessionNames`) — they should
  vanish once the drain fix ships.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

The two defects are independent; both are mechanical given the pointers above.

**Drain resilience (Defect 1).** Replace the single all-or-nothing `failed`
flag with per-resource accounting so an entry leaves the queue once nothing
*reapable* remains. Concretely:

- **t3code-paused → skip, not failure.** Gate the t3code arm on
  `t3codeIntegrationEnabled()`: when integration is paused, skip thread
  deletion entirely (optionally log once) and do **not** set `failed`. Only
  when integration is *enabled* and the server is transiently unreachable does
  the arm mark the entry for retry. This single change drains the dominant
  bulk of the backlog.

- **Benign worktree/branch no-ops do not pin.** These steps already throw only
  on genuine errors and have defense-in-depth (`purgeOrphanDirIfRecoverable`);
  ensure an entry with already-gone resources is treated as success.

- Keep a notion of "retain only if a genuinely retryable resource remains."
  The simplest faithful shape: track whether any *retryable* sub-step failed
  (transient, worth another tick) separately from benign/skip outcomes, and
  push to `remaining` only on a retryable failure. A bounded-retry / hard-age
  ceiling (drop with a logged warning past, say, the 72h cap) is optional
  defense-in-depth against any permanently-unreapable step the coder can add
  if it falls out cleanly; it is not required to satisfy the ACs.

**Cadence (Defect 2).** Add a `processDeferredCleanups()` call to the
`action === "health-check"` branch in `src/mag.ts`, mirroring the
briefing-precompute try/catch (dynamic import + `try/catch` logging
`"ludics: deferred cleanup failed:"`). Place it alongside the existing
`runAllTestHealth()` call so it rides the same gated 4h cadence. Keep the
briefing call. Do not change `cleanupDelayHours` or the grace default.

After code changes, rebuild: `bun run build; ludics init --no-triggers`.

## Scope

**In scope:**
- Per-resource / paused-skip drain resilience in
  `src/orchestration/deferred-cleanup.ts` (`processDeferredCleanups`).
- A second reaper trigger on the 4h health-check code path in `src/mag.ts`.
- Tests in `src/orchestration/deferred-cleanup.test.ts` (and, if the
  health-check wiring is tested, the relevant mag/health test).

**Out of scope (explicit user decisions):**
- **No manual purge or hand-edit of `mag/cleanup-pending.json`** — the
  360-entry backlog must drain naturally once the fix ships.
- Un-pausing t3code (gh-ludics-539 stays paused).
- Changing the grace-period default (`cleanup_delay_hours` / 25h) or the 72h
  cap.

**Dependencies:** none blocking. Same family as already-shipped task-9a9e7989
and task-d2a16a60; relates to task-0d1f8d76.
