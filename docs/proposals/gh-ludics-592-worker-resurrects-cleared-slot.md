# Worker resurrects a CLEARED remote slot and continues orchestration on a DONE task

## Goal

A remote worker (`minipc-wsl`) resurrected a slot the controller had **cleared**
and continued a detached orchestration on an **already-completed** task — it
re-created the coder + reviewer tmux sessions and a worktree ~1h after teardown,
then **autonomously opened and merged** `ocaml-cudajit` PR #11, entirely
invisible to the controller and dashboard (which showed all six slots empty).

Issue: https://github.com/lukstafi/ludics/issues/592

This is the dangerous sibling of the merged remote-orchestration fixes
gh-ludics-579 (path translation), gh-ludics-580 (worker resume uses
controller-live slot state), and gh-ludics-584 (runner cgroup-escape + resume
circuit-breaker). Those *are* in `main`, but the worker was running a clone
**~15 commits behind** because its harness auto-sync was **silently stuck**:
`git pull --ff-only` aborts when the worker's tracked harness tree is dirty,
and the worker had local uncommitted writes to `journal/notifications.jsonl`,
`mag/queue.jsonl`, and `mag/cleanup-pending.json`. So the worker could neither
receive the controller's cleared `slot-4.json` nor the deployed 580/584 fixes.

The incident has two independent root causes; both must be fixed for the issue
to be resolved:

- **Defect 1** — the worker could re-create orchestration for a slot the
  controller reports empty (resurrection after teardown).
- **Defect 2** — the worker's harness auto-sync was stalled by its own local
  tracked-file writes, so it never received controller-live state at all.

## Acceptance Criteria

1. **Worker never writes the tracked harness notifications log.** `notifyLog`
   (`src/notify.ts`) does not append to `journal/notifications.jsonl` when
   running in worker context (`isWorkerContext()` true). On a worker the
   notification is forwarded to the controller (mirroring the existing
   `journalAppend` worker-forward path) or no-ops; it must not dirty the
   tracked tree. Controller/standalone behavior is unchanged (the log is still
   written).

2. **Worker never writes the tracked harness request queue.** The queue writers
   in `src/queue.ts` that append to `mag/queue.jsonl` (`queueRequest`,
   `queueRequestAtHead`, `queueReinsertHead`, and any other writer that mutates
   the queue file) do not write the tracked harness queue file when
   `isWorkerContext()` is true — they no-op (the request queue is the
   Mag-coordinator's, which only the controller drains). Controller/standalone
   behavior is unchanged.

3. **Worker never writes the tracked harness deferred-cleanup file.**
   `saveDeferredCleanups` (`src/orchestration/deferred-cleanup.ts`) does not
   write `mag/cleanup-pending.json` under the tracked harness when
   `isWorkerContext()` is true — it routes to the worker cache
   (`workerCacheDir()`, à la gh-ludics-580) or no-ops. Controller/standalone
   behavior is unchanged.

4. **Every tracked-harness writer the worker exercises is guarded.** A worker
   running through a full orchestration lifecycle (assign → setup → plan →
   work → review → PR → merge → cleanup, including the failure/notification
   paths) leaves its tracked harness tree **clean** — `git status --porcelain`
   over the tracked harness files shows no worker-originated modifications, so
   `git pull --ff-only` always succeeds. (`journalAppend` in `src/journal.ts`
   is already guarded — confirm it stays guarded; the new guards cover the
   remaining writers enumerated in AC1–AC3 plus any others surfaced while
   tracing the worker's exercised write paths.)

5. **Worker can never resurrect a slot the controller reports empty.**
   `maybeResumeDeadOrchestrators` (`src/mag.ts`) never re-creates orchestration
   (tmux sessions / worktree / runner) for a slot whose controller-live
   `freshSlots` row is `(empty)`, and never falls back to a stale local harness
   clone when a fresh controller view is available. When `freshSlots` is null
   on a worker (controller unreachable), the resume path skips the tick rather
   than reading the local clone. (The current loop already `continue`s on
   `(empty)` and returns early for a worker with null `freshSlots` — this AC is
   to confirm and lock that invariant with a test that exercises the
   resurrection scenario: a worker whose local clone still shows a slot
   assigned/live but whose `freshSlots` reports `(empty)`.)

6. **Regression tests.**
   - Defect 2: per-writer worker-guard tests proving each guarded writer
     (notifications log, queue, deferred-cleanup) does **not** touch the
     tracked harness tree in worker context and **does** in
     controller/standalone context. Borrow the worker-context setup used by the
     existing `$HOME/.ludics-orch-cache` round-trip tests
     (`src/adapters/tmux-adapter.test.ts`, `src/mag.test.ts`).
   - Defect 1: a `maybeResumeDeadOrchestrators` test where the worker's local
     harness clone shows a slot live but the controller-live `freshSlots` row
     is `(empty)` — assert no resume/resurrection occurs. Borrow the
     remote-dispatch / `freshSlots` scaffolding in `src/slots/index.test.ts`
     and `src/mag.test.ts`.

7. **No automatic `reset --hard` / `stash` backstop.** The fix must NOT add an
   automatic destructive sync (`git reset --hard origin/main` / `git stash`) to
   the worker harness refresh. Per the resolved question, that is too risky
   (it would discard worker-local runtime writes each sync). The guards keep
   the tree clean so plain `--ff-only` succeeds; recovery of an
   already-drifted worker stays a manual one-shot, out of scope here.

## Context

How things work now (key files and symbols, `~/ludics`):

### Defect 2 — tracked-harness writers on the worker

- `journalAppend` (`src/journal.ts`) **already** has a worker guard: when
  `clusterCurrentMachineName() && !clusterIsController()`, it forwards via
  `clusterPostJournal` (`src/cluster-http.ts`) and returns without a local
  write. This is the precedent to mirror.
- `notifyLog` (`src/notify.ts`) appends to `journal/notifications.jsonl` via
  `notificationLogFile()` → `harnessDir()` **unconditionally** — no worker
  guard. The dashboard reader `generateNotifications` (`src/dashboard.ts`)
  reads the same file (read-only).
- The queue writers in `src/queue.ts` (`queueRequest`, `queueRequestAtHead`,
  `queueReinsertHead`, `queueReinsertHeadWithFreshId`, …) append to
  `mag/queue.jsonl` via `queueFile()` → `harnessDir()` under `withQueueLock`,
  **unconditionally**.
- `saveDeferredCleanups` (`src/orchestration/deferred-cleanup.ts`) writes
  `mag/cleanup-pending.json` via `cleanupPendingPath()` → `harnessDir()`,
  **unconditionally** (`recordDeferredCleanup` / `cancelDeferredCleanup` call
  it).
- The worker-context detector is `isWorkerContext()` (`src/orchestration/state.ts`,
  exported), which returns `clusterCurrentMachineName() && !clusterIsController()`.
  The non-harness worker cache root is `workerCacheDir()` (same file) →
  `$HOME/.ludics-orch-cache`, already used by `readOrchestrationState` /
  `persistState` / `removeOrchestrationState` for worker-side orchestration
  state (gh-ludics-580). The worker harness refresh is `git pull --ff-only`
  (equivalently `git merge --ff-only origin/main`), which aborts on a dirty
  tree. `tasksSync` (`src/tasks/sync.ts`) early-returns on workers and is not
  the harness refresh; `statePull` (`src/state.ts`) is the existing
  `reset --hard` path but is documented handoff-only — out of scope per AC7.

### Defect 1 — worker resurrection of a cleared slot

- `slotClear` (`src/slots/index.ts`, "CONTROLLER-ONLY") tears down the local
  view and, for a remote slot, calls `slotStop(slot, /* force */ true, /*
  preserveState */ false)`. In `slotStop`, the remote+force branch logs
  `force-clearing local state (skipping remote stop on ${ctx.machine})` and
  mutates only local controller state — it does **not** record a worker-bound
  stop intent. Per the resolved question, the chosen primary mechanism is
  **worker-side reconciliation**, not an active stop intent, so this branch is
  left as-is.
- `maybeResumeDeadOrchestrators` (`src/mag.ts`) is the worker-side resume loop.
  Post-580 it already:
  - iterates controller-live `freshSlots` when provided, and `continue`s on
    any row whose `data.process` is `(empty)` (the resurrection guard);
  - returns early on a worker when `freshSlots` is null
    (`if (isWorkerNode()) return;`) instead of falling back to
    `readAllSlotJson` (the stale-clone guard);
  - skips slots owned by another machine, and slots marked
    `interrupted`/`escalated`.
  The incident predates 580 *being deployed on the worker* (defect 2 kept the
  worker on a pre-580 clone). With defect 2 fixed, the worker reliably has the
  fresh view. AC5 confirms and locks the invariant with a direct resurrection
  test; the nuance that reconciliation prevents *re-creation* but does not
  actively reap an orchestration still live at the instant of clear is
  acknowledged and intentionally out of scope (a future stop-intent via
  `ensureRemoteMachineReachable`/`recordIntent` would be the mechanism if
  prompt active reaping is later wanted).

### Test scaffolding to borrow

- Worker-context cache round-trip setup: `src/adapters/tmux-adapter.test.ts`
  (`$HOME/.ludics-orch-cache/tmux` round-trip, harness untouched) and
  `src/mag.test.ts` (`orchCacheDir()` helper).
- Remote-dispatch / `freshSlots` / `setWorkerSlotsOverride` patterns:
  `src/slots/index.test.ts` (`describe("remote slot dispatch via HTTP")`,
  `describe("slotResume — …")`) and `src/mag.test.ts`.

## Approach

*Suggested approach — agents may deviate if they find a better path.*

Defect 2 is mechanical and follows the established `isWorkerContext()` /
`journalAppend` precedent: at the top of each unguarded tracked-harness writer
(`notifyLog`, the `src/queue.ts` writers, `saveDeferredCleanups`), branch on
`isWorkerContext()` and either forward to the controller (notifications, to
mirror `journalAppend` → `clusterPostJournal`; a `clusterPostNotification`
analogue may be added if a worker legitimately needs to surface notifications)
or no-op / route to `workerCacheDir()`. The queue is the coordinator's, drained
only by the controller, so a worker no-op is appropriate. **Trace the worker's
actually-exercised write paths** (per AC4) so no tracked-harness writer is
missed — a single missed writer re-introduces the stall.

Defect 1 is largely a confirmation-and-lock: the existing
`maybeResumeDeadOrchestrators` guards already satisfy the invariant. Add the
resurrection regression test (AC5/AC6) and, if the trace surfaces any path that
can read a stale local clone when a fresh controller view exists, close it.

## Scope

In scope:
- Worker-context guards for the notifications-log, request-queue, and
  deferred-cleanup tracked-harness writers (defect 2).
- Confirming/locking the `maybeResumeDeadOrchestrators` no-resurrection
  invariant with a regression test (defect 1).
- Per-writer worker-guard tests and the resurrection regression test.

Out of scope:
- Any automatic `reset --hard` / `stash` worker-sync backstop (AC7).
- One-time recovery of an already-drifted worker (manual, per the issue).
- Active stop-intent delivery on remote `slot clear` (reconciliation is the
  chosen primary; a stop intent is a possible later enhancement, not this
  task).
- The local runner-leak concern of `task-72a318c3` (separate proposal,
  separate slot/clear bug).

Relates to gh-ludics-589 and the merged remote-orchestration chain
gh-ludics-579 / gh-ludics-580 / gh-ludics-584.
