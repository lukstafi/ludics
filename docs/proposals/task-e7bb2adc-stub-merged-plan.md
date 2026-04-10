# Proposal: Auto-create stub merged plan when planning phase is skipped

**Task**: task-e7bb2adc
**Date**: 2026-04-09

## Goal

When orchestration skips the planning phase (`enablePlan: false`), automatically create a stub merged plan file containing a `## Pre-existing test failures (baseline)` section so the reviewer template does not fall back to treating all test failures as blocking.

## Acceptance Criteria

- [ ] When transitioning from any pre-work phase directly to `work` (planning skipped), a stub merged plan file is created at the standard path (`plans/round-{N}-merged-0.md`).
- [ ] The stub contains a `## Pre-existing test failures (baseline)` section with text indicating planning was skipped (e.g., `(not recorded -- planning was skipped)`).
- [ ] The stub is NOT created if a real merged plan already exists for the current round (i.e., no overwrite of legitimate plan files).
- [ ] The reviewer template's fallback text is updated: when the baseline section indicates planning was skipped, the reviewer should not block on test failures unless clearly related to the task's changes.
- [ ] Works for both `pair` and `duo` modes.
- [ ] The stub is only created on the initial entry to work from pre-work (not on review -> work round loops, which already have round > 1 and prior context).

## Context

When `enablePlan` is false, `nextAfterPrework()` in `phases.ts:377-398` returns `"work"` directly. No plan files are created. The reviewer template (`pair-reviewer-review.md:9`) checks for the merged plan's baseline section and falls back to "treat all failures as potentially blocking" when absent. This caused 5+ wasted review rounds across task-7b0f4c78 and task-2a72dde6.

Key code locations:
- `src/orchestration/phases.ts:377-398` -- `nextAfterPrework()` returns `"work"` when `enablePlan` is false
- `src/orchestration/runner.ts:1176-1247` -- `applyPhaseSideEffects()` handles phase transition side effects; already has logic for plan-merge skip (line 1197-1210) that copies solo plan to merged path
- `src/orchestration/plan-files.ts:25-36` -- `mergedPlanFilePath()` utility
- `skills/orchestration/pair-reviewer-review.md:9` -- reviewer baseline check instruction

## Approach

### 1. Create stub in `applyPhaseSideEffects()` (runner.ts)

Add a clause after the existing plan-merge skip logic (around line 1210). When transitioning to `"work"` from a pre-work phase and no merged plan exists for the current round:

```typescript
// When planning is skipped entirely (pre-work → work), create a stub merged plan
// so the reviewer template finds a baseline section and doesn't block on pre-existing failures.
if (next === "work" && PHASE_CATEGORIES[state.phase] === "pre-work") {
  const mergedPath = mergedPlanFilePath(state.peerSyncDir, state.round, 0);
  if (!existsSync(mergedPath)) {
    mkdirSync(join(state.peerSyncDir, "plans"), { recursive: true });
    writeFileSync(mergedPath, STUB_MERGED_PLAN_CONTENT);
  }
}
```

The stub content:

```markdown
# Stub Plan (planning phase skipped)

## Pre-existing test failures (baseline)

(not recorded -- planning was skipped)
```

This requires importing `PHASE_CATEGORIES` from `phases.ts` and `mkdirSync` from `fs` (both already available or trivially added).

### 2. Update reviewer template (pair-reviewer-review.md)

Modify the fallback sentence from:

> If the merged plan has no baseline section (older plan format), treat all failures as potentially blocking.

To:

> If the merged plan has no baseline section (older plan format), treat all failures as potentially blocking. If the baseline section says planning was skipped, do not block on test failures unless they are clearly caused by the task's changes.

### 3. Edge case handling

- **Round > 1 (review -> work loop)**: The condition `PHASE_CATEGORIES[state.phase] === "pre-work"` ensures the stub is only created on the initial pre-work -> work transition. Later review -> work transitions have `state.phase === "review"` or `"update-docs"`, which are `"main-loop"` category, so the stub logic is not triggered.
- **Existing merged plan**: The `!existsSync(mergedPath)` guard prevents overwriting real plans.
- **Plans directory missing**: `mkdirSync(..., { recursive: true })` handles this.
