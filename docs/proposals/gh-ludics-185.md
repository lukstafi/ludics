# Fix remote resume/start spin loop when remote node is unresponsive

## Goal

Eliminate the resource-wasting spin loop where the controller writes resume/start intent files (each triggering a git commit+push) every keepalive cycle (~1 min) for remote slots whose nodes are offline. The fix targets three independent causes: remote PID liveness checks that always fail for remote PIDs, missing heartbeat guards on `slotResume()`, and missing intent dedup in `maybeResumeDeadOrchestrators()`.

## Acceptance Criteria

1. `maybeResumeDeadOrchestrators()` skips slots assigned to a remote machine entirely. Remote workers run their own keepalive with local PID checks; the controller should not attempt `process.kill(pid, 0)` on PIDs from another host.
2. `slotResume()` checks `heartbeatIsFresh(ctx.machine)` before writing a remote resume intent, mirroring the existing guard in `slotStart()`. If the heartbeat is stale, it throws an error (`"assigned machine <name> is offline -- cannot resume"`).
3. `maybeAutoStartSlots()` already has a fresh-intent dedup guard for start intents (lines 1961-1963). A parallel guard is added to any remaining code path that could call `slotResume()` for remote slots in an automated loop: before calling `slotResume()`, check `readSlotIntent(slotNum)` and skip if a fresh resume intent already exists.
4. After these changes, an offline remote node produces zero resume/start intent writes per keepalive cycle (verified by log output and absence of repeated `"remote resume intent slot N"` commit messages).
5. When a remote node comes back online (heartbeat becomes fresh) and the previous intent has expired, the controller resumes dispatching normally on the next keepalive cycle.
6. Existing tests pass. New or updated tests cover: (a) `slotResume()` throws when heartbeat is stale, (b) `maybeResumeDeadOrchestrators()` skips remote slots.

## Context

### Root cause

Two independent spin-loop paths in the controller keepalive:

**Path 1 (primary): `maybeResumeDeadOrchestrators()` in `src/mag.ts` (~line 2466)**

For each slot with orchestration state, checks PID liveness via `process.kill(pid, 0)`. For remote slots the PID belongs to another host, so the call always throws -- the orchestrator appears "dead" every cycle. This calls `slotResume(slotNum)` which writes a resume intent + `stateCheckpoint(push: true)` every ~1 minute.

**Path 2 (secondary): `maybeAutoStartSlots()` in `src/mag.ts` (~line 1931)**

Already has a fresh-intent dedup guard (lines 1961-1963) that prevents re-writing start intents within the 10-min TTL. After TTL expiry it writes a new one, producing a slow spin (~every 10 min). This is acceptable behavior for start intents but the heartbeat guard in `slotStart()` already prevents writes when the node is offline.

### Asymmetry between slotStart and slotResume

`slotStart()` (`src/slots/index.ts` ~line 638) has:
```typescript
if (!heartbeatIsFresh(ctx.machine)) {
  throw new Error(`slot ${slotNum}: assigned machine ${ctx.machine} is offline — cannot start`);
}
```

`slotResume()` (`src/slots/index.ts` ~line 753) has no such guard -- it writes the intent unconditionally for remote machines.

### Intent infrastructure

- `src/slot-intents.ts`: `writeSlotIntent()`, `readSlotIntent()`, `intentIsFresh()`, `clearSlotIntent()`
- Intent TTL: 600 seconds (10 minutes)
- `src/federation.ts:183`: `heartbeatIsFresh()` uses 15-min timeout

## Approach

### Change 1: Skip remote slots in `maybeResumeDeadOrchestrators()`

In `src/mag.ts`, inside the `for` loop of `maybeResumeDeadOrchestrators()`, after extracting the slot's machine name, add:

```typescript
const slotMachine = getMachine(block).trim();
if (slotMachine && slotMachine !== "null" && isRemoteMachine(slotMachine)) continue;
```

This is the highest-impact fix: it eliminates the primary spin loop entirely. The remote worker's own keepalive handles PID liveness locally.

### Change 2: Add heartbeat guard to `slotResume()`

In `src/slots/index.ts`, inside the remote-dispatch branch of `slotResume()` (line ~766), add the same heartbeat check that `slotStart()` has:

```typescript
if (ctx.machine && isRemoteMachine(ctx.machine)) {
  if (!heartbeatIsFresh(ctx.machine)) {
    throw new Error(`slot ${slotNum}: assigned machine ${ctx.machine} is offline — cannot resume`);
  }
  // ... existing intent write logic
}
```

This is a defense-in-depth guard: even if `slotResume()` is called from other code paths (CLI, Mag queue), it won't write intents for offline nodes.

### Change 3: Fresh-intent dedup for resume (defense-in-depth)

If there are any remaining automated paths that could call `slotResume()` for remote slots, add the same dedup pattern used in `maybeAutoStartSlots()`:

```typescript
const existingIntent = readSlotIntent(slotNum);
if (existingIntent && existingIntent.action === "resume" && intentIsFresh(existingIntent)) continue;
```

This is a belt-and-suspenders guard for the resume path, preventing duplicate intent writes within the TTL window.

### Not included (deferred)

- **Exponential backoff**: Not needed now that the spin loop is eliminated. Could be added later if slow-spin on start intents (every 10 min) becomes a concern.
- **Max-retry stalled marking**: Useful but orthogonal. Can be filed as a follow-up if needed.
