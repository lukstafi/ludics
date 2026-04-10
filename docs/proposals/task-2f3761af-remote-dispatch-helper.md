# Proposal: Extract shared ensureRemoteMachineReachable helper

**Task:** task-2f3761af
**Date:** 2026-04-09

## Goal

Eliminate duplicated remote-dispatch logic across `slotStart`, `slotStop`, and `slotResume` by extracting a shared `ensureRemoteMachineReachable` helper, and fix the missing `clusterMachine()` null-check in `slotStop`'s non-force path.

## Acceptance Criteria

- [ ] A new `ensureRemoteMachineReachable` helper function exists in `src/slots/index.ts` (or a nearby module) that encapsulates: `heartbeatIsFresh` guard, `clusterMachine` null-check, dynamic `recordIntent` import, intent recording, console log, journal append, and event emission.
- [ ] `slotStart`, `slotResume`, and `slotStop` (non-force path) all delegate to this helper instead of inlining the remote-dispatch pattern.
- [ ] `slotStop` non-force path now includes the `clusterMachine()` null-check (via the helper), matching `slotStart` and `slotResume` behavior.
- [ ] The helper accepts a generic intent payload parameter to accommodate varying payloads (`{ taskId }` for start/resume, `{ taskId, preserveState }` for stop).
- [ ] The helper accepts the adapter mode and action string to produce correct event types (`slot_start_queued`, `slot_stop_queued`, `slot_resume_queued`).
- [ ] All existing tests in `src/slots/index.test.ts` continue to pass without modification (behavior-preserving refactor).
- [ ] A new test verifies that `slotStop` on a remote machine with missing cluster config throws an appropriate error.

## Context

All three remote-dispatch blocks in `src/slots/index.ts` follow an identical pattern:

1. Check `heartbeatIsFresh(machine)` -- throw if offline
2. Call `clusterMachine(machine)` -- throw if null (**missing in slotStop**)
3. Dynamically import `recordIntent` from `cluster-http.ts`
4. Record intent with action-specific payload
5. Log to stderr, append to journal, emit a `slot_{action}_queued` event
6. Return (skip local execution)

The only variations are:
- **Action string**: `"start"`, `"stop"`, `"resume"`
- **Intent payload**: stop adds `preserveState`
- **slotStop force path**: skips remote dispatch entirely (stays in caller)

Source: retrospective from task-8d4a972a. Related: gh-ludics-185 (heartbeat guards), task-9cfff815 (remote dispatch test fixtures).

## Approach

1. **Define the helper** in `src/slots/index.ts` (private, not exported) with signature:
   ```typescript
   async function ensureRemoteMachineReachable(
     slotNum: number,
     machine: string,
     action: string,
     adapter: string,
     intentPayload: Record<string, unknown>
   ): Promise<void>
   ```
   The function performs steps 1-5 above. Callers invoke it and `return` afterward.

2. **Refactor callers**:
   - `slotStart`: replace lines 697-710 with `await ensureRemoteMachineReachable(slotNum, ctx.machine, "start", ctx.mode, { taskId: ctx.taskId }); return;`
   - `slotResume`: replace lines 844-857 with `await ensureRemoteMachineReachable(slotNum, ctx.machine, "resume", ctx.mode, { taskId: ctx.taskId }); return;`
   - `slotStop` non-force path: replace lines 802-811 with `await ensureRemoteMachineReachable(slotNum, ctx.machine, "stop", ctx.mode, { taskId: ctx.taskId, preserveState }); return;`

3. **Add test** for slotStop cluster-config missing case: mock `clusterMachine` to return null for a remote machine, call `slotStop`, assert it throws with "no cluster config" message.
