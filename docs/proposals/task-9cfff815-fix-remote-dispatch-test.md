# Proposal: Fix pre-existing remote dispatch test failure in slots/index.test.ts

**Task ID**: task-9cfff815

## Goal

Fix the failing "remote slotStart fails fast when no cluster config for machine" test in `src/slots/index.test.ts` by writing a heartbeat fixture file for "worker-a" before calling `slotStart(1)`, so the heartbeat freshness guard added in commit `27b2ba3` does not reject the call as offline.

## Acceptance Criteria

1. All tests in `src/slots/index.test.ts` pass (0 failures).
2. The "remote slotStart fails fast when no cluster config for machine" test writes a fresh heartbeat file for "worker-a" before invoking `slotStart(1)`, so the test exercises the intended code path (remote dispatch / no cluster config) rather than hitting the offline guard.
3. A separate test ("remote slotStart fails fast when machine is offline") explicitly covers the offline guard path by omitting the heartbeat fixture.
4. No production code changes.

## Context

- The heartbeat freshness guard was added in commit `27b2ba3` to `src/slots/index.ts` (line ~652).
- `heartbeatIsFresh()` lives in `src/cluster.ts` and checks `<harness>/federation/heartbeats/<nodeName>.json` for a recent `epoch`.
- The remote dispatch test suite was introduced in `f33ef66` before the guard existed; only `slotStart` has this guard (not `slotStop`/`slotResume`).
- Fix was applied in commit `a42138a`.

## Approach

1. In the "remote slotStart fails fast when no cluster config" test, before `slotStart(1)`:
   - Call `getHeartbeatsDir()` (imported from `../cluster.ts`).
   - Create the heartbeats directory with `mkdirSync(..., { recursive: true })`.
   - Write `worker-a.json` with `{ epoch: Math.floor(Date.now() / 1000) }`.
2. Add a companion test "remote slotStart fails fast when machine is offline" that omits the heartbeat fixture and expects the `"offline — cannot start"` error.
3. Apply the same heartbeat fixture pattern to the "remote slotResume fails fast when no cluster config" test for consistency.
