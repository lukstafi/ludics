# Proposal: Orchestration setup failure marks slot Interrupted instead of clearing

## Goal

When orchestration setup fails (tmux session creation, worktree creation, orchestration process spawn), the slot must remain assigned with an "Interrupted" liveness status rather than being silently cleared to empty. This prevents the next keepalive from overwriting the slot with a different task (orphaning the original task's frontmatter).

## Acceptance Criteria

- [ ] Orchestration setup failure sets slot to Interrupted state (not empty)
- [ ] Dashboard shows Interrupted with Resume button for failed setups
- [ ] Task frontmatter is not left in orphaned in-progress state
- [ ] maybeFillEmptySlots skips Interrupted slots (only fills truly empty ones)

## Context

**Observed bug (2026-04-03):** task-7d0021cd was auto-assigned to slot 6 at 10:02:43. By 10:03:47, `maybeFillEmptySlots` saw slot 6 as empty and assigned task-fecf65ee, overwriting the first assignment. task-7d0021cd was left with stale in-progress frontmatter.

**Two code paths trigger the bug:**

1. **`launchSessionFromNotification`** (mag.ts ~line 952-976): Calls `slotAssign` then `slotStart`. On failure, the catch block calls `slotClear(slotNum, "ready")` which resets the slot to `(empty)`. This is the rollback that makes the slot look free.

2. **`maybeAutoStartSlots`** (mag.ts ~line 1888-1893): Calls `slotStart(slotNum)` for slots that have proposals but no active session. On failure, the catch block just logs the error. The slot stays assigned (not cleared), but since `Session Started` was never set, the next keepalive cycle will retry `slotStart` -- if that also fails repeatedly, the slot is effectively stuck but not overwritten. However, if the underlying adapter `start()` throws partway through after creating partial state, the next attempt may hit the "recoverable orchestration state" guard and throw, leaving the slot permanently stuck.

**Root cause in adapter `start()` (tmux-adapter.ts):** The `start()` function performs multiple setup steps sequentially (createWorktrees, initPeerSync, createTmuxAgentSession, startOrchestrationProcess). If any step throws, the caller receives the error but the slot block in `slots.md` still has the task assigned with Process set. However, no orchestration state/PID file exists, so `computeSlotLiveness` returns `null` instead of `"interrupted"`.

**Why liveness is `null` not `"interrupted"`:** `computeSlotLiveness` checks for an orchestration PID in `tmux-slot-N.json` (tmux) or `slot-N-state.json` (t3code). If setup fails before `writeTmuxSlotState` (which is the last step in `start()`), no PID file exists, so liveness returns `null`. The dashboard renders `null` liveness as "Waiting" (no session started) rather than "Interrupted".

**Why `maybeFillEmptySlots` overwrites:** `maybeFillEmptySlots` checks `getProcess(block).trim()` for `"(empty)"`. If `launchSessionFromNotification` rolls back with `slotClear`, the process field becomes `(empty)`, making it eligible for auto-fill.

## Approach

### Fix 1: `launchSessionFromNotification` -- mark Interrupted instead of clearing

In the catch block (~line 955-976), instead of calling `slotClear(slotNum, "ready")`, leave the slot assigned. The slot already has the task assigned from `slotAssign` call. The key change: do NOT clear the slot on setup failure. Instead:

- Leave the slot block as-is (task remains assigned, Process field non-empty)
- Write a minimal orchestration state marker so `computeSlotLiveness` detects it as interrupted. Specifically, write a stub `tmux-slot-N.json` or `slot-N-state.json` with `pid: -1` (sentinel for "setup failed"). `computeSlotLiveness` already returns `"interrupted"` when the PID exists but `processAlive(pid)` returns false -- a PID of -1 will never be alive.
- Emit a `slot_setup_failed` event for observability
- Send notification about the failure (already done)

### Fix 2: `maybeAutoStartSlots` -- prevent infinite retry loops  

In the catch block (~line 1892), after a failed `slotStart`:
- Write the same stub orchestration state marker (pid: -1) so the slot shows as Interrupted in the dashboard
- The existing `maybeResumeDeadOrchestrators` will then pick it up for resume attempts, which is the correct recovery path

### Fix 3: Adapter `start()` cleanup on partial failure

In `tmux-adapter.ts` `start()` (~line 390-517), wrap the setup in a try/catch that performs partial cleanup on failure:
- If worktrees were created but orchestration process failed, clean up worktrees and peer-sync state
- This prevents stale worktrees from accumulating on repeated setup failures
- Re-throw the error after cleanup so callers still see the failure

### Fix 4: `maybeFillEmptySlots` robustness (defense in depth)

`maybeFillEmptySlots` already only fills slots where `process === "(empty)"`. With Fix 1, the slot won't be cleared, so this is already handled. No change needed here -- the fix is at the source (don't clear the slot).

### Files to modify

| File | Change |
|------|--------|
| `src/mag.ts` | `launchSessionFromNotification` catch block: stop clearing slot, write stub state marker |
| `src/mag.ts` | `maybeAutoStartSlots` catch block: write stub state marker for interrupted liveness |
| `src/adapters/tmux-adapter.ts` | `start()`: add try/catch for partial cleanup, re-throw |
| `src/adapters/t3code.ts` | Same pattern: `start()` partial cleanup (t3code adapter has same bug) |

### Stub state marker helper

Add a helper function (e.g., `writeSetupFailedMarker(slot, harnessDir, backend)`) that writes the minimal state file needed for `computeSlotLiveness` to return `"interrupted"`:

- For tmux: write `tmux-slot-N.json` with `{ slot: N, ttydPids: {}, orchestration: { stateFile: "", mode: "duo", pid: -1 } }`
- For t3code: write `slot-N-state.json` with `{ orchestration: { pid: -1 } }` (minimal shape)

This reuses the existing liveness detection logic without modifying `computeSlotLiveness`.

### Testing

- Manual: assign a task, break worktree creation (e.g., invalid project path), verify slot shows Interrupted in dashboard
- Verify `maybeFillEmptySlots` does not overwrite the slot on next keepalive
- Verify Resume button appears and works after fixing the underlying issue
