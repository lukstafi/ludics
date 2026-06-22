# Worker dead-orchestrator resume must use controller-live slot state (not the stale local harness clone)

**Task**: gh-ludics-580
**Repo**: lukstafi/ludics
**Blocks**: task-66a3bbff (CUDA cudajit-offset; minipc-wsl is the federation's sole CUDA host)
**Sibling**: gh-ludics-579 (controller→worker path translation — separate task, out of scope here)

## Goal

On a federation **worker**, the keepalive's dead-orchestrator auto-resume must
resolve slot state from the same authoritative source the **START** path
already uses — the controller-live state fetched over HTTP — instead of
falling back to the worker's stale, git-tracked local harness clone. Today the
asymmetry causes a worker to refuse resume on a slot it legitimately owns,
looping `orchestration_auto_resume_failed` indefinitely.

This was the second of two defects on the **first live remote orchestration
launch** (controller mac-studio/macOS → worker minipc-wsl/Linux, slot 4): 5
`orchestration_auto_resume_failed` events, 17:26–17:34Z, after the orchestrator
runner died in `setup`.

### Validated mechanism (code read at commit 384724d)

The worker keepalive (`workerKeepalive`, `src/mag.ts`) fetches controller-live
slots over HTTP into `freshSlots` and hands them to two functions:

1. **START** — `processSlotIntents(freshSlots)` (`src/mag.ts:3560`). Before
   executing an intent it sets `setWorkerSlotsOverride(freshSlots)` in a
   try/finally (`src/mag.ts:3587` / `:3595`), so `readSlot` inside `slotStart`
   returns controller-live state. It also returns early when `!freshSlots` on a
   worker (`src/mag.ts:3568`). **This is why START works.**

2. **RESUME** — `maybeResumeDeadOrchestrators(freshSlots)` (`src/mag.ts:3421`).
   It iterates `freshSlots` (so the remote-machine skip at `src/mag.ts:3439`
   correctly sees the *fresh* machine and proceeds), but calls
   `slotResume(slotNum)` (`src/mag.ts:3468`) **without** the override.

Inside `slotResume` (`src/slots/index.ts`), `readSlot` — override null —
reads the **stale local `slots/slot-N.json`** (the worker's clone was ~15
commits behind; slot 4 still held machine `mac-studio`, task `task-850e1b37`).
Then `isRemoteMachine("mac-studio")` is `true` on the worker →
`ensureRemoteMachineReachable(... "resume")` → `heartbeatIsFresh("mac-studio")`
is `false` from the worker's vantage → throws *"assigned machine mac-studio is
offline — cannot resume"* → caught → `orchestration_auto_resume_failed`. Every
keepalive tick re-fails. The loop.

The asymmetry **is** the bug. Federation v2 ("controller-only harness writes,
HTTP for all cross-node comms") forbids a worker from treating its local clone
as authoritative — yet the resume path does exactly that.

### Why no worker state-pull, and why orch-state is already fine

- `statePull` (`src/state.ts:112`) is **handoff-only** by design (the comment
  notes it is "NOT used during normal operation — the controller's local state
  is authoritative"). The fix must **not** introduce worker-side pulling; that
  contradicts the architecture. The correct response is to stop the lifecycle
  path from ever trusting the local clone.
- `readOrchestrationState` (`src/orchestration/state.ts:632`) is **already
  worker-cache-aware**: it branches on `isWorkerContext()` and reads a
  non-harness cache (`workerCacheFilePath`, under `$HOME/.ludics-orch-cache`,
  written by the runner via `persistState`). The orch-state reads in the resume
  path are therefore fresh-correct — only the **slot** read is stale.

## Acceptance Criteria

### Core fix — worker resume uses controller-live slot state

1. **Override around `slotResume` in `maybeResumeDeadOrchestrators`**
   (`src/mag.ts`): the call to `slotResume(slotNum)` is wrapped in
   `setWorkerSlotsOverride(freshSlots)` / `setWorkerSlotsOverride(null)` via
   try/finally, mirroring `processSlotIntents` (`src/mag.ts:3587`/`:3595`). The
   override is applied only on the worker path (when `freshSlots` is the
   controller-live map — i.e. not standalone/controller). After this, `readSlot`
   inside `slotResume` returns the controller-live machine and current task, so
   a slot the worker legitimately owns resolves to **local** execution and
   resume proceeds instead of throwing "machine offline".

2. **Skip when controller-live state is unavailable (Q2 → (a))**: on a worker,
   when `freshSlots` / `clusterGetSlots()` is null, `maybeResumeDeadOrchestrators`
   **skips** dead-orchestrator auto-resume for that tick — it does **not** fall
   back to reading the local clone (`readAllSlotJson`). The next keepalive tick
   retries once the controller is reachable. (Note: the existing
   `freshSlots ?? readAllSlotJson(...)` fallback at the top of the function is
   what must be guarded — local-clone fallback is acceptable on the **controller/
   standalone** path, never on a worker.)

3. **No worker-side state pull is added**: `statePull` remains handoff-only; no
   change makes the worker pull/refresh its local harness clone during normal
   operation.

### Extended scope (Q1) — migrate per-slot t3code/tmux state to worker-cache

4. **`readSlotState` / `writeSlotState` / `removeSlotState`**
   (`src/t3code/server.ts:94`–`112`) become worker-cache-aware, mirroring
   `readOrchestrationState` / `persistState` / `removeOrchestrationState`: on a
   worker (`isWorkerContext()`) they read/write/remove a **non-harness** local
   cache rather than the git-tracked harness tree (`harnessDir/t3code/slot-N.json`).
   On controller/standalone, behavior is unchanged (harness tree).

5. **`readTmuxSlotState` / `writeTmuxSlotState` / `removeTmuxSlotState`**
   (`src/adapters/tmux-adapter.ts:95`–`125`) likewise become worker-cache-aware:
   on a worker they read/write/remove a non-harness local cache rather than
   `harnessDir/orchestration/tmux-slot-N.json`. On controller/standalone,
   behavior is unchanged.

6. **Cache location is consistent with the orch-state precedent**: the worker
   cache for t3code/tmux slot state lives outside the harness tree (e.g. a
   sibling of `$HOME/.ludics-orch-cache`), so a worker's per-slot adapter state
   never lands in the git-tracked harness and never participates in sync. The
   exact directory and whether the `isWorkerContext` / cache-path helpers are
   shared (exported from `state.ts`) or replicated is an implementation choice —
   provided the worker branch reads/writes the same path it writes/reads (no
   read/write path mismatch) and the controller branch is untouched.

### Tests

7. **Worker-resume routing test** (new): in a worker context where `freshSlots`
   reports the slot's machine = *self* and the current task, but the local
   `slots/slot-N.json` is **stale** (machine = some other/remote machine),
   auto-resume routes to **local** execution and does **not** throw the
   remote-offline refusal. Borrow the remote-dispatch / off-cluster-guard
   scaffolding in `src/slots/index.test.ts` (around `:2204`, `:2415`) and the
   `setWorkerSlotsOverride` pattern.

8. **Null-`freshSlots` skip test** (new): in a worker context with `freshSlots`
   null, `maybeResumeDeadOrchestrators` performs **no** resume and does **not**
   read the local clone — even when a stale local `slots/slot-N.json` would
   otherwise look resumable.

9. **Slot-state worker-cache migration test(s)**: in a worker context,
   `writeSlotState` (t3code) and `writeTmuxSlotState` write to the non-harness
   cache and the corresponding read returns it, while the git-tracked harness
   path is **not** written; on controller/standalone the harness path is used as
   before. (Round-trip + a negative assertion that the harness tree is untouched
   on the worker path.)

## Context / pointers

- START-path override pattern to mirror: `src/mag.ts:3587` (`setWorkerSlotsOverride(freshSlots)`)
  inside try, `:3595` (`setWorkerSlotsOverride(null)`) in finally; early-return on
  null `freshSlots` for workers at `src/mag.ts:3568`.
- `maybeResumeDeadOrchestrators`: `src/mag.ts:3421`; the stale fallback to guard
  is `const slots = freshSlots ?? readAllSlotJson(slotsCount())` near `:3425`;
  the unwrapped `slotResume(slotNum)` is near `:3468`.
- `setWorkerSlotsOverride` / `workerSlotsOverride` / `readSlot`:
  `src/slots/index.ts:72`, `:68`, `:129`.
- Worker-cache precedent to mirror: `readOrchestrationState` /`persistState` /
  `removeOrchestrationState` at `src/orchestration/state.ts:632`/`:653`/`:669`;
  private helpers `workerCacheDir` (`:403`), `workerCacheFilePath` (`:407`),
  `isWorkerContext` (`:411`).
- Functions to migrate: `src/t3code/server.ts:94` (`readSlotState`), `:101`
  (`writeSlotState`), `:107` (`removeSlotState`); `src/adapters/tmux-adapter.ts:95`
  (`readTmuxSlotState`), `:109` (`writeTmuxSlotState`), `:118`
  (`removeTmuxSlotState`).
- No existing test covers `maybeResumeDeadOrchestrators` / `processSlotIntents` /
  `workerSlotsOverride` interplay (`src/*.test.ts`, `src/slots/*.test.ts` grep
  empty); `src/slots/index.test.ts` has remote-dispatch scaffolding to borrow.
- The minipc-wsl slot ran **tmux** mode; the tmux resume branch reconstructs
  from `orchState` (worker-cache, fresh) and tolerates a missing tmux-slot file
  (gh-ludics-559), so once the machine-mismatch refusal is gone, resume proceeds.

## Out of scope

- gh-ludics-579 (controller ships its own `/Users/...` path to the Linux worker
  → worktree ENOENT) — separate task.
- Any worker-side `statePull` / local-harness refresh during normal operation —
  contradicts federation v2; explicitly excluded.

## Effort

Medium. Core fix is a small, well-isolated mirror of an existing pattern; the
bulk is the parallel t3code/tmux worker-cache migration (six functions, two
files) plus the new test coverage for a path that currently has none.
