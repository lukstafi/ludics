# Proposal: Extract resetPrCommentsState helper

**Task:** task-cb41bc69
**Date:** 2026-04-09

## Goal

Consolidate the two pr-comments state reset sites in `src/orchestration/runner.ts` into a single `resetPrCommentsState()` helper function, so that adding or modifying pr-comments tracking fields in the future requires changes in only one place.

## Acceptance Criteria

1. A new exported helper function `resetPrCommentsState(state: OrchestrationState): void` exists in `src/orchestration/runner.ts` (or a suitable module).
2. The helper resets all pr-comments phase-entry fields to their canonical initial values:
   - `prCommentsLastCheckAt` = `state.phaseStartedAt - 600` (10-minute lookback)
   - `prCommentsQuietSince` = `undefined`
   - `prCommentsCoderDispatched` = `false`
   - `prMergeableStates` = `{}`
   - `prCodexReviewFallbackPosted` = `undefined`
3. The helper does NOT reset `prCodexReviewDeferredSince` (it has an independent lifecycle, set elsewhere via `armCodexReviewDeferral`).
4. `enterPhase()` (line ~514, `state.phase === "pr-comments"` block) calls `resetPrCommentsState(state)` instead of inline assignments.
5. `applyPhaseSideEffects()` (line ~1186, `next === "pr-comments"` block) calls `resetPrCommentsState(state)` instead of inline assignments.
6. Both sites now reset the same set of fields — the current inconsistency (enterPhase resets `prCommentsLastCheckAt` and `prCommentsQuietSince` but applyPhaseSideEffects does not) is resolved by having both call the same helper.
7. All existing orchestration tests pass without modification (behavior-preserving refactor).

## Context

The pr-comments phase tracks several state fields that must be reset on phase entry:
- `prCommentsLastCheckAt` — epoch of last GitHub comment poll, set to 10 min before phase start to catch comments posted during preceding phases.
- `prCommentsQuietSince` — quiet period tracker; reset to `undefined` on entry.
- `prCommentsCoderDispatched` — whether coder has been re-dispatched for new comments.
- `prMergeableStates` — per-agent mergeable state cache, reset to `{}` on fresh entry.
- `prCodexReviewFallbackPosted` — whether the Codex review fallback comment was posted; reset to `undefined` on entry.

Currently, `enterPhase()` (lines 514-518) resets `prCommentsLastCheckAt`, `prCommentsQuietSince`, `prCommentsCoderDispatched`, and defensively initializes `prMergeableStates`. `applyPhaseSideEffects()` (lines 1186-1189) resets `prMergeableStates`, `prCommentsCoderDispatched`, and `prCodexReviewFallbackPosted`. The two sites reset overlapping but different subsets of fields — a maintenance hazard.

## Approach

1. **Define the helper** near the top of the pr-comments section in `runner.ts` (or as a private function near the existing reset sites). The function signature:
   ```typescript
   function resetPrCommentsState(state: OrchestrationState): void {
     state.prCommentsLastCheckAt = state.phaseStartedAt - 600;
     state.prCommentsQuietSince = undefined;
     state.prCommentsCoderDispatched = false;
     state.prMergeableStates = {};
     state.prCodexReviewFallbackPosted = undefined;
   }
   ```

2. **Replace inline resets in `enterPhase()`** (lines 514-518): replace the four field assignments with a single `resetPrCommentsState(state)` call. Keep the subsequent agent lifecycle/fingerprint clearing logic unchanged.

3. **Replace inline resets in `applyPhaseSideEffects()`** (lines 1186-1189): replace the three field assignments with a single `resetPrCommentsState(state)` call.

4. **Verify** that all orchestration tests pass. No behavioral change is expected — the only net effect is that `applyPhaseSideEffects` now additionally resets `prCommentsLastCheckAt` and `prCommentsQuietSince`, which is correct (these were previously only reset on resume via `enterPhase`, not on initial transition).
