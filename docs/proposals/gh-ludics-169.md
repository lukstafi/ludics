# Proposal: Remove legacy migration code

**Task**: gh-ludics-169

## Goal

Remove three independent pieces of legacy migration code that are no longer needed: the `maybeStartDispatchedSlots()` function (old SSH dispatch), the deprecated directory-walk fallback in the stop hook, and the `network.nodes` compatibility shim in federation config. All three have been superseded by their respective replacement systems and carry explicit deprecation markers.

## Acceptance Criteria

1. `maybeStartDispatchedSlots()` function and its call site in `workerKeepalive()` are deleted from `src/mag.ts`.
2. The directory-walk fallback block (tier 3) is deleted from `templates/hooks/ludics-on-stop.sh`, and surrounding comments no longer reference directory walk.
3. The `network.nodes` compat shim (including `_networkNodesDeprecationWarned`) is deleted from `src/federation.ts`.
4. Legacy compat tests in `src/federation.test.ts` (`describe("legacy network.nodes compat")`, lines 51-239) are deleted.
5. The `network.nodes` deprecation comment is removed from `templates/harness/config.yaml`.
6. All remaining tests pass (`bun test`), with the following pre-existing exclusions (neither file is modified by gh-ludics-169):
   - `src/slots/index.test.ts` ("remote slotStart writes a start intent and does not stamp Session Started"): fails identically on the base branch; the test requires a fresh heartbeat file for machine `worker-a` which is not provisioned by the test fixture.
   - `src/t3code/client.test.ts` (3 tests): fails with `EADDRINUSE` on port `0` in some environments due to Bun runtime socket exhaustion or parallel test runner contention. The tests use `Bun.serve({ port: 0 })` for OS-assigned ephemeral ports; the `EADDRINUSE` error is environmental, not a code defect. This file is not touched by gh-ludics-169.
7. Build succeeds (`bun run build`).

## Context

### Item 1: `maybeStartDispatchedSlots()` in `src/mag.ts`

- **Function**: lines 2625-2699 -- detects slots dispatched via the old SSH scheme (recognized by "Session Started" stamp) and starts them. Has a 10-minute TTL guard.
- **Call site**: line 2554 in `workerKeepalive()`, with migration comment at line 2552-2553.
- **Replaced by**: `processSlotIntents()` (line 2547), the intent-based dispatch system shipped with gh-ludics-160.
- **Import note**: `getSessionStarted` is used in 5+ other call sites across `mag.ts`, `dashboard.ts`, and `slots/index.ts` -- the import must NOT be removed.

### Item 2: Directory-walk fallback in `templates/hooks/ludics-on-stop.sh`

- **Block**: lines 88-101 -- walks up from `$cwd` looking for `.peer-sync/phase` files.
- **Comments to update**:
  - Line 16: remove "3. Directory walk up from cwd to find .peer-sync/phase -- legacy fallback."
  - Line 54: change "env var > marker file > directory walk" to "env var > marker file"
  - Lines 56-57: remove "deprecated dir walk-up" from the parenthetical
  - Line 105: change "(via env var, marker file, or dir walk)" to "(via env var or marker file)"

### Item 3: `network.nodes` compat shim in `src/federation.ts`

- **Variable**: `_networkNodesDeprecationWarned` at line 31.
- **Shim block**: lines 52-73 in `federationConfig()` -- converts legacy `network.nodes` entries to `federation.machines` format.
- **Tests**: `src/federation.test.ts` lines 51-239 (`describe("legacy network.nodes compat")`) -- 6 test cases exercising the compat path.
- **Config comment**: `templates/harness/config.yaml` line 127-128 -- deprecation note for `network.nodes`.
- **Historical docs**: references in `docs/proposals/federation-runtime.md` are historical and should be left as-is.

## Approach

All three items are independent and can be done in a single commit:

1. **Delete** `maybeStartDispatchedSlots()` (lines 2625-2699) and its call site + comments (lines 2552-2554) in `src/mag.ts`.
2. **Delete** the directory-walk fallback block (lines 88-101) in `templates/hooks/ludics-on-stop.sh` and **update** four comment blocks that reference it (lines 16, 54, 56-57, 105).
3. **Delete** `_networkNodesDeprecationWarned` (line 31) and the compat shim block (lines 52-73) in `src/federation.ts`.
4. **Delete** the `describe("legacy network.nodes compat")` test block (lines 51-239) in `src/federation.test.ts`.
5. **Delete** the `network.nodes` deprecation comment (lines 127-128) in `templates/harness/config.yaml`.
6. **Verify** `bun test` and `bun run build` pass.
