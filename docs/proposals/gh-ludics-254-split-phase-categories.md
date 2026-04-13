# Proposal: Split PHASE_CATEGORIES — distinguish pre-plan from planning phases

**Task:** gh-ludics-254
**Date:** 2026-04-13

## Goal

Split the `"pre-work"` phase category into `"pre-plan"` (setup, gather, clarify, pushback) and `"planning"` (plan, plan-merge, plan-review) so category-based checks can distinguish between "planning was skipped" and "planning was attempted."

## Acceptance Criteria

1. `PhaseCategory` type includes `"pre-plan"` and `"planning"` instead of `"pre-work"`.
2. `PHASE_CATEGORIES` maps setup/gather/clarify/pushback → `"pre-plan"` and plan/plan-merge/plan-review → `"planning"`.
3. `handleTimeout()` (runner.ts:939-940) updated: skips `"pre-plan" || "planning" || "terminal"`.
4. `applyPhaseSideEffects()` (runner.ts:1203-1204) uses `PHASE_CATEGORIES[state.phase] === "pre-plan"` instead of inline `PRE_PLAN_PHASES` array.
5. Regression tests for stub-plan creation: (a) created when pre-plan → work, (b) not overwritten when merged plan exists, (c) not created when planning → work.
6. `bun run build` succeeds, all tests pass.

## Context

Current mapping (phases.ts:43-50): all 7 phases map to `"pre-work"`. This caused a bug in task-e7bb2adc where a category check for "planning was skipped" incorrectly matched phases where planning was attempted but failed.

Two consumers in runner.ts:
- Line 939-940: `handleTimeout()` — `if (category === "pre-work" || category === "terminal") return;`
- Line 1203-1204: `applyPhaseSideEffects()` — inline `PRE_PLAN_PHASES` array already makes the distinction manually

## Approach

### 1. Update type and mapping (phases.ts:35-50)

```typescript
export type PhaseCategory = "pre-plan" | "planning" | "main-loop" | "pr" | "merge" | "post-merge" | "terminal";

export const PHASE_CATEGORIES: Record<Phase, PhaseCategory> = {
  setup: "pre-plan",
  gather: "pre-plan",
  clarify: "pre-plan",
  pushback: "pre-plan",
  plan: "planning",
  "plan-merge": "planning",
  "plan-review": "planning",
  // ... rest unchanged
};
```

### 2. Update handleTimeout (runner.ts:939-940)

```typescript
const category = PHASE_CATEGORIES[state.phase];
if (category === "pre-plan" || category === "planning" || category === "terminal") return;
```

### 3. Simplify applyPhaseSideEffects (runner.ts:1199-1204)

Replace:
```typescript
const PRE_PLAN_PHASES: readonly Phase[] = ["setup", "gather", "clarify", "pushback"];
if (next === "work" && PRE_PLAN_PHASES.includes(state.phase)) {
```

With:
```typescript
if (next === "work" && PHASE_CATEGORIES[state.phase] === "pre-plan") {
```

### 4. Add regression tests (phases.test.ts)

Three test cases for stub-plan creation behavior, testing `applyPhaseSideEffects`:
- `setup → work` (pre-plan skip) creates stub plan
- `plan-review → work` (planning attempted) does NOT create stub plan
- `setup → work` with existing merged plan does NOT overwrite

### Files to modify

- `src/orchestration/phases.ts` — `PhaseCategory` type, `PHASE_CATEGORIES` mapping
- `src/orchestration/runner.ts` — `handleTimeout()`, `applyPhaseSideEffects()`
- `src/orchestration/phases.test.ts` — add regression tests
