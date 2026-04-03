# Proposal: Federation — communicate remote slot state to controller

**Task:** task-6b3772fc
**Project:** ludics
**Date:** 2026-04-03

## Goal

Enable the controller to see real-time slot state (phase, round, agent status, PR URLs, liveness) for remote-owned slots via git-backed state synchronization. Currently remote slots are fire-and-forget: the controller dispatches SSH commands but has no visibility into what happens afterward. The dashboard shows stale or missing data for remote slots.

## Acceptance Criteria

1. **Worker push to state repo**: Workers commit and push orchestration state changes to the shared state repo during their keepalive checkpoint cycle. The current `isController()` guard in `stateCheckpoint()` that blocks worker pushes is relaxed so workers can also push.

2. **Controller reads remote orchestration state from git**: The dashboard (`generateSlots()`) reads orchestration state for remote slots from committed files pulled via `statePull()`, rather than skipping them. Remote slot phase, round, PR URLs, and agent thread links are displayed.

3. **Remote liveness via heartbeat staleness**: For remote-owned slots, liveness is inferred from the machine's federation heartbeat freshness (already committed to `federation/heartbeats/<machine>.json`). A remote slot is "alive" if its machine heartbeat is fresh and "interrupted" if stale. No SSH PID probing needed.

4. **Machine name badge**: The `SlotJson` interface gains a `machine: string | null` field. The dashboard frontend displays a badge with the machine name for slots owned by a different machine than the controller.

5. **Merge conflict strategy for shared files**: Worker pushes use `git pull --rebase` before pushing to linearize history. For append-only files (`journal/events.jsonl`), rebase conflicts are auto-resolved by accepting both sides (the append-only nature makes this safe). For `slots.md`, ownership conventions apply: workers only modify Runtime/Terminals sections of their own slots; the controller owns slot assignment/clearing. A conflict on `slots.md` is resolved by accepting the incoming (remote) version and re-applying local changes, since controller and worker modify disjoint slot sections.

## Context

### Current architecture

- **`stateCheckpoint()`** (`src/state.ts:111`): Commits accumulated changes and optionally pushes. The push is gated by `isController()` — workers never push.
- **`statePull()`** (`src/state.ts:140`): Stash/pull-rebase/pop. Currently only called by `federationTick()` on the controller.
- **`federationTick()`** (`src/federation.ts:377`): Controller-only. Pulls state, publishes heartbeat, elects controller, polls worker signals via SSH, then checkpoints.
- **`generateSlots()`** (`src/dashboard.ts:181`): Reads `slots.md` and local `readOrchestrationState(slot)`. For remote slots, orchestration state files don't exist locally, so phase/round/PR/links are all null.
- **`computeSlotLiveness()`** (`src/dashboard.ts:48`): Uses `process.kill(pid, 0)` for local PID check. Remote slots are explicitly skipped (lines 267-269).
- **Orchestration state files**: `orchestration/slot-N.json` — written by the orchestration runner on the machine running the slot. These are inside the harness git tree but never committed by workers.
- **Heartbeat files**: `federation/heartbeats/<machine>.json` — committed during federation tick. Already contain `mag_running`, `epoch`.

### Key files to modify

| File | Change |
|------|--------|
| `src/state.ts` | Allow workers to push; add pull-before-push with conflict resolution |
| `src/dashboard.ts` | Add `machine` field to SlotJson; use heartbeat for remote liveness |
| `src/federation.ts` | Workers also publish heartbeats and checkpoint/push during tick |
| `src/mag.ts` | Worker keepalive also runs a checkpoint+push cycle |
| `dashboard/` (frontend) | Display machine badge when `machine` differs from controller |

## Approach

### 1. Enable worker push in `stateCheckpoint()`

Remove or relax the `isController()` guard in `stateCheckpoint()`. Instead, all machines commit and push. Add a `statePullBeforePush()` helper that does `pull --rebase` before pushing, with retry on conflict. This replaces the bare `statePush()` call.

```
stateCheckpoint() flow (all machines):
  git add -A → git commit → statePullBeforePush()

statePullBeforePush():
  git pull --rebase
  if conflict on events.jsonl → auto-resolve (accept both, sort by timestamp)
  if conflict on slots.md → auto-resolve (accept theirs for non-owned slots)
  if conflict on other → abort rebase, re-commit on top
  git push (retry once on rejection)
```

### 2. Worker keepalive checkpoint

In `magStart()` keepalive path (around line 2470), the `stateCheckpoint("keepalive")` call already exists. Once the `isController()` guard is removed, workers will automatically push during keepalive. Workers should also call `heartbeatPublish()` during keepalive so their heartbeat files are committed and pushed.

### 3. Dashboard reads remote state from git

`generateSlots()` already calls `readOrchestrationState(num)` for each slot. Since orchestration state files (`orchestration/slot-N.json`) will now be committed and pushed by workers, the controller will see them after `statePull()`. No dashboard code change needed for phase/round/PR — it already reads from the file if present.

The only change: add `machine` field to `SlotJson` (read from `getMachine(block)`) and expose it to the frontend.

### 4. Remote liveness from heartbeat

Replace the current skip-remote-slots logic in `generateSlots()` (lines 264-271) with:
- For remote slots: read the machine's heartbeat file, check `epoch` freshness. If fresh, mark `liveness: "alive"`. If stale (older than `HEARTBEAT_TIMEOUT`), mark `liveness: "interrupted"`.
- Keep local PID-based liveness for local slots (unchanged).

### 5. Merge conflict auto-resolution

Add a `resolveRebaseConflicts()` helper in `src/state.ts`:
- For `events.jsonl`: accept both versions concatenated (append-only, each line is independent JSON).
- For `slots.md`: use `git checkout --theirs` for the file, then re-apply local slot block changes. In practice, workers only write orchestration state files (not `slots.md` directly), so `slots.md` conflicts are rare — only if the controller reassigns a slot while the worker is pushing.
- For heartbeat JSON files: accept ours (most recent writer wins for their own file).
- For any other file: accept ours (local version) as a safe default, log a warning.

### 6. Machine badge in frontend

The dashboard frontend (`dashboard/index.html` or equivalent) reads `SlotJson.machine`. If non-null and different from the current controller machine name (exposed via a new `controller_machine` field in the dashboard JSON), display a small badge (e.g., "[desktop]") next to the slot number.
