# Proposal: Fix dashboard stateMarkDirty bug and extract shared setQueueHold helper

**Task**: task-e86f4a64
**Project**: ludics
**Date**: 2026-04-05

## Goal

Fix the missing `stateMarkDirty()` call in the dashboard queue-hold endpoint and eliminate logic duplication by extracting a shared `setQueueHold(held, source)` helper.

## Acceptance Criteria

1. **Bug fix**: The dashboard `/api/queue-hold` endpoint calls `stateMarkDirty()` before `stateCheckpoint()`, so sentinel file changes are actually committed and synced.

2. **Shared helper**: A single `setQueueHold(held: boolean, source: string): boolean` function in `src/mag.ts` encapsulates:
   - Guard: early return `false` if state already matches (held and already held, or not held and not held)
   - Sentinel file write (`writeFileSync`) or delete (`unlinkSync`), with `mkdirSync` safety for the hold case
   - Event emission (`emitEvent` with `event_type: "queue_hold"`, the provided `source`, and `action: "hold"|"resume"`)
   - `stateMarkDirty()` + `stateCheckpoint("queue-hold")`
   - Returns `true` if state was changed, `false` if no-op

3. **CLI callers refactored**: `queueHold()` and `queueResume()` in `src/mag.ts` become thin wrappers that call `setQueueHold(true/false, "cli")` and print the appropriate console message.

4. **Dashboard caller refactored**: The `/api/queue-hold` handler in `src/dashboard-server.ts` calls `setQueueHold(held, "dashboard")` instead of inline logic. The `lastGenerated = 0` line remains after the call to force dashboard regeneration.

5. **No behavior change** for read-only callers: `isQueueHeld()`, `queueHoldFilePath()`, `queueHoldStatus()`, and the `existsSync` check in `src/dashboard.ts` line 778 remain unchanged.

6. **Import cleanup**: `dashboard-server.ts` no longer needs to import `stateCheckpoint` from `./state.ts` (unless used elsewhere in the file), nor `writeFileSync`/`unlinkSync`/`mkdirSync` for the hold endpoint. It imports `setQueueHold` from `./mag.ts` instead.

## Context

- **Bug location**: `src/dashboard-server.ts` line 467 calls `stateCheckpoint("queue-hold")` without `stateMarkDirty()`. Since the `queue-hold` sentinel is untracked by git, `git diff --quiet HEAD` returns 0 and the checkpoint is a no-op -- the change is never committed.
- **Duplication sites**: dashboard endpoint (lines 452-467), `queueHold()` (mag.ts ~line 2171), `queueResume()` (mag.ts ~line 2184).
- **Dependency**: PR #182 (task-55c366c6) added `queueHold()`/`queueResume()` with the correct `stateMarkDirty()` call. This task can be done on top of that branch or after it merges.

## Approach

1. Add `export function setQueueHold(held: boolean, source: string): boolean` in `src/mag.ts` near line 2158 (the queue-hold section), containing the unified hold/resume logic.

2. Simplify `queueHold()` and `queueResume()` to:
   ```typescript
   export function queueHold(): void {
     if (!setQueueHold(true, "cli")) {
       console.log("Queue is already held -- no change.");
       return;
     }
     console.log("Queue held -- auto-assignment suppressed.");
   }
   ```
   (Analogous for `queueResume()`.)

3. In `src/dashboard-server.ts`, replace the inline hold/resume logic (lines 451-467) with:
   ```typescript
   import { setQueueHold } from "./mag.ts";
   // ...
   const held = stateParam === "true";
   setQueueHold(held, "dashboard");
   lastGenerated = 0;
   ```

4. Clean up now-unnecessary imports in `dashboard-server.ts` (check if `stateCheckpoint`, `writeFileSync`, `unlinkSync`, `mkdirSync` are still needed by other code paths before removing).
