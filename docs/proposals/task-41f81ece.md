# Proposal: PR #69 Followups — Lifecycle Unit Tests, Stop-Hook Env Var, Remove Deprecated Fields

**Task**: task-41f81ece
**Status**: proposal
**Date**: 2026-03-28

## Summary

Three cleanup items from the PR #69 (dispatch-scoped turn lifecycle tracking) coder reflections. Each is independent and can be merged separately.

## 1. Lifecycle Unit Tests for `updateTurnLifecycle()` and `refreshAgentStatuses()`

### Current State

`runner.test.ts` already has solid coverage of `updateTurnLifecycle()` (7 tests covering all state transitions) and stop-hook fast-complete logic (2 tests). However, the tests for `refreshAgentStatuses()` are indirect — they test the stop-hook logic by reimplementing it in the test rather than calling the actual function.

### Proposed Changes

Add focused unit tests in `runner.test.ts`:

**a) `updateTurnLifecycle` edge cases** (expand existing describe block):
- `dispatched` with `sessionStatus === "starting"` (no activeTurnId yet) -- should stay `dispatched`
- `dispatched` with `sessionStatus === "error"` before ever reaching `running` -- should stay `dispatched` (error only applies from running state; confirmed by reading the switch statement)
- `running` with `activeTurnId` present but `sessionStatus !== "running"` (e.g., `"ready"`) -- should transition to `settled`
- `running` with `latestTurn === null` and session not running -- should use `isoNow()` as fallback `turnCompletedAt`

**b) `refreshAgentStatuses` mock-based tests** (new describe block):
- Extract `refreshAgentStatuses` as an exported function (currently module-private) or test it indirectly via a thin wrapper
- **Null snapshot handling**: verify that when snapshot is `null`, lifecycle state does not change (the null guard in `updateTurnLifecycle` at the `running` state handles this)
- **Stop-hook + lifecycle coordination**: test the full `refreshAgentStatuses` path with a real peer-sync dir, stop-hook record, and lifecycle in various states
- **Inconsistency detection**: verify that `detectAgentInconsistencies` emits a warning event when peer-sync says "done" but lifecycle says "dispatched" or "running"

### Implementation Notes

`refreshAgentStatuses` is currently not exported. Two options:
1. **Export it** (preferred): it has no side effects beyond mutating state and emitting events; both are testable
2. **Test via `pollUntilDone`**: too heavy; requires mocking the t3code client, snapshot, sleep, etc.

Recommend option 1: add `export` to `refreshAgentStatuses` and write tests with a real tmp peer-sync dir and mock snapshot data.

### Files Modified
- `src/orchestration/runner.ts` — export `refreshAgentStatuses`
- `src/orchestration/runner.test.ts` — new test describe blocks

## 2. Stop-Hook Phase Token via Env Var

### Current State

The stop hook shell script (`templates/hooks/ludics-on-stop.sh`) already resolves `LUDICS_PEER_SYNC_DIR` via three priority paths:
1. Env var `LUDICS_PEER_SYNC_DIR` (set by SessionStart hook in `.claude/settings.local.json`)
2. Marker file `.ludics-orchestration.json` directory walk
3. Legacy `.peer-sync/phase` directory walk

The `orchOnStop()` handler in `index.ts` receives `peerSyncDir` as a CLI argument (from the shell script) and reads the phase token from the `phase-token` file on disk.

The task asks to **pass the phase token as an env var** to replace the directory-walk heuristic. However, the phase token changes each phase transition (it is regenerated in `enterPhase()`), while the SessionStart hook only fires once at session initialization. So a static env var cannot carry a per-phase token.

### Proposed Changes

Instead of a phase-token env var (which would be stale after the first phase transition), the improvement is to:

**a) Make `orchOnStop` use `LUDICS_PEER_SYNC_DIR` directly** when available, skipping the CLI argument for peer-sync discovery:
- In `orchOnStop()`, check `process.env.LUDICS_PEER_SYNC_DIR` as a primary source for `peerSyncDir` when the CLI arg is missing or invalid
- This makes the env var the authoritative routing mechanism, with CLI arg as fallback

**b) Remove the legacy directory-walk fallback** (path 3 in the shell script):
- The SessionStart hook (`writeAgentMarkerFiles`) and marker file already cover all orchestration scenarios
- The directory walk is fragile (matches wrong `.peer-sync` dirs in nested worktrees)
- Gate removal behind a deprecation period: log a warning when the directory walk fires, remove in a subsequent release

### Files Modified
- `src/orchestration/index.ts` — `orchOnStop()`: add env-var check for `peerSyncDir`
- `templates/hooks/ludics-on-stop.sh` — deprecation warning on directory-walk path

## 3. Remove Deprecated Fields

### Current State

The task mentions removing `latestTurnState`, `latestTurnCompletedAt`, and `phaseDispatchedAt` from `OrchestrationState`. However, **none of these fields exist in the current codebase**:

- `OrchestrationState` in `state.ts` does not contain `latestTurnState`, `latestTurnCompletedAt`, or `phaseDispatchedAt`
- A grep across the entire `src/` directory confirms zero references to these field names
- The only references are in historical docs (`docs/proposals/task-e7352102.md` and `docs/orchestration-phase-transitions.md`) which describe the old design that PR #69 replaced

These fields were apparently removed as part of PR #69 itself. The task acceptance criterion is already satisfied.

### Proposed Changes

**No code changes needed.** The deprecated fields have already been removed. The acceptance criterion can be checked off.

Optionally: update `docs/orchestration-phase-transitions.md` to remove references to `phaseDispatchedAt` and the old `latestTurnState`/`latestTurnCompletedAt` approach (lines ~115-116), since they describe superseded behavior.

### Files Modified
- `docs/orchestration-phase-transitions.md` — remove stale references to deprecated fields (optional cleanup)

## Scope and Risk

- **Lifecycle tests** (item 1): Zero runtime risk; test-only changes plus exporting one function
- **Stop-hook env var** (item 2): Low risk; the env var path already works in the shell script, this adds it as a fallback in the TypeScript handler
- **Deprecated fields** (item 3): Already done; optional doc cleanup only

## Ambiguities

1. **`refreshAgentStatuses` export**: Should we export it directly, or create a testable wrapper? Direct export is simpler but slightly widens the public API surface. Recommendation: export it; it is already effectively public through `pollUntilDone`.

2. **Directory-walk removal timeline**: Should the legacy directory-walk fallback (path 3 in `ludics-on-stop.sh`) be removed now, or just deprecated with a warning? Recommendation: add warning now, remove in a follow-up after confirming no environments rely on it.

3. **Deprecated fields already removed**: The task lists removing `latestTurnState`, `latestTurnCompletedAt`, and `phaseDispatchedAt`, but these are already gone from the code. Should we close this acceptance criterion as pre-satisfied, or is there additional cleanup expected? Recommendation: mark as done, optionally clean up stale doc references.

## Estimated Effort

- Item 1 (tests): ~1 hour
- Item 2 (env var): ~30 minutes
- Item 3 (deprecated fields): ~15 minutes (doc cleanup only)
- Total: ~2 hours
