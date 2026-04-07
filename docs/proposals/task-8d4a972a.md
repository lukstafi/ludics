# Proposal: Add heartbeatIsFresh check to slotStop remote path

**Task**: task-8d4a972a  
**Effort**: small  
**Status**: ready

## Goal

Make `slotStop` consistent with `slotStart` and `slotResume` by checking whether the target machine is online before recording a stop intent. Currently, the non-force remote branch of `slotStop` calls `recordIntent` without verifying the machine is reachable, which can silently queue a stop intent for an offline machine that will never execute it.

## Acceptance Criteria

1. Calling `slotStop` on a slot assigned to an offline remote machine (no fresh heartbeat) throws `"offline — cannot stop"` — matching the behaviour of `slotStart` (`"offline — cannot start"`) and `slotResume` (`"offline — cannot resume"`).
2. The `--force` path is unaffected: it continues to bypass the heartbeat check and clear controller-side state locally.
3. A new test `"remote slotStop (non-force) fails fast when machine is offline"` passes, modelled on the existing `"remote slotStart fails fast when machine is offline"` test (line 732).
4. All existing tests continue to pass.

## Context

`src/slots/index.ts`:

- `slotStart` (line 718–733): checks `heartbeatIsFresh(ctx.machine)` at line 719, throws on stale heartbeat, then records intent.
- `slotResume` (line 907–922): same pattern at line 908.
- `slotStop` (line 844–857): the non-force branch (lines 848–856) calls `recordIntent` immediately with no heartbeat check.

The inconsistency was surfaced during the `gh-ludics-202` review as a potential documentation deadlock (stop intent queued for an offline machine, never consumed, slot state diverges).

## Approach

### Code change (`src/slots/index.ts`, ~line 848)

Insert a `heartbeatIsFresh` guard at the start of the non-force else-branch, before the `recordIntent` call:

```typescript
} else {
  if (!heartbeatIsFresh(ctx.machine)) {
    throw new Error(`slot ${slotNum}: assigned machine ${ctx.machine} is offline — cannot stop`);
  }
  // Record stop intent — worker polls and executes on next keepalive (pure pull model)
  const { recordIntent } = await import("../federation-http.ts");
```

That is 3 lines inserted at the start of the existing `else` block. No other logic changes.

### Test change (`src/slots/index.test.ts`, after line 742)

Add one test after `"remote slotStart fails fast when machine is offline"` (or adjacent to the existing slotStop remote tests near line 744):

```typescript
test("remote slotStop (non-force) fails fast when machine is offline", async () => {
  const harness = join(TMP, "ludics-state", "harness");
  const tasksDir = join(harness, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeTask(tasksDir, "task-remote-stop-offline", "Remote stop offline test");

  slotAssign(1, "task-remote-stop-offline", "tmux", "", "", "", "worker-a");

  // No heartbeat → machine offline
  await expect(slotStop(1, false, false)).rejects.toThrow("offline — cannot stop");
});
```

No heartbeat file is written, so `heartbeatIsFresh("worker-a")` returns false, triggering the throw.

## Out of Scope

- The `--force` path: intentionally bypasses the heartbeat check by design. No change.
- `federationMachine` null-check in `slotStop`: `slotStart` and `slotResume` also check for a valid federation config entry after the heartbeat check. `slotStop` non-force path does not currently do this. That is a separate (lower-priority) gap and is not addressed here.
