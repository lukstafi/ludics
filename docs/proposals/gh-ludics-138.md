# Skip plan-merge phase when only one plan file exists

## Goal

When only one agent submits a plan in pair mode (typically the coder writes a plan but the reviewer doesn't), the plan-merge phase is wasted: the coder receives `"(no plan yet)"` for the peer plan and simply promotes the solo plan. This adds a full agent round-trip with no value.

Skip plan-merge when fewer than 2 plan files exist, going directly to plan-review instead.

Ref: https://github.com/lukstafi/ludics/issues/138

## Acceptance Criteria

1. In pair mode, when the plan phase completes and only one plan file exists (glob `plans/round-{round}-*.md` excluding merged files), the orchestrator transitions directly from `plan` to `plan-review` instead of `plan-merge`.
2. The solo plan file is copied to the merged plan path (`plans/round-{round}-merged-0.md`) so that plan-review skill templates read it via the same path they use after a real merge.
3. When two plan files exist, behavior is unchanged (plan -> plan-merge -> plan-review).
4. Duo mode is unaffected (it already skips plan-merge).
5. Existing tests continue to pass; a new test covers the single-plan skip path.

## Context

**Phase transition logic** (`src/orchestration/phases.ts`):
- Line 395-401: `evaluateTransition` plan case -- pair mode unconditionally returns `"plan-merge"`. This is where the plan-file count check should be added.
- Line 404-406: plan-merge case transitions to plan-review (unchanged).
- Line 150-165: `agentParticipatesInPhase` -- only coder participates in plan-merge.

**Plan artifact paths** (`src/orchestration/phases.ts`):
- Line 76: Individual plan: `plans/round-${round}-${agent.name}.md`
- Line 80: Merged plan: `plans/round-${round}-merged-${planMergeRound}.md`

**Skill context** (`src/orchestration/skills.ts`):
- Line 192-209: `buildSkillContext` -- plan-review in pair mode reads the merged plan file. The solo plan must be copied to this path for plan-review to work without changes.

**Runner side effects** (`src/orchestration/runner.ts`):
- Line 1085-1091: `planMergeRound` increment on plan-review -> plan-merge loop. Unaffected when plan-merge is skipped (planMergeRound stays at 0).

**Existing tests** (`src/orchestration/phases.test.ts`):
- Line 116-131: Tests pair plan -> plan-merge transition (needs a parallel test for single-plan skip).
- Line 144-157: Tests plan-merge -> plan-review.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

1. **`phases.ts` -- `evaluateTransition` plan case**: Before returning `"plan-merge"` in pair mode, count plan files matching `plans/round-${round}-*.md` (excluding `*-merged-*`). If count < 2, return `"plan-review"` instead.

2. **`runner.ts` -- phase transition side effects** (near line 1085): When transitioning from `plan` directly to `plan-review` (i.e., plan-merge was skipped), find the single plan file and copy it to the merged plan path (`plans/round-${round}-merged-0.md`). This ensures plan-review skill templates read the plan correctly.

3. **`phases.test.ts`**: Add a test that sets up pair mode with plan phase complete but only one plan file on disk, and asserts the transition is `"plan-review"` (not `"plan-merge"`).

## Scope

**In scope:**
- `evaluateTransition` change in `phases.ts`
- Copy-on-skip side effect in `runner.ts`
- Test for single-plan transition in `phases.test.ts`

**Out of scope:**
- Changing duo mode behavior
- Modifying skill templates
- Skipping plan-merge based on task "triviality" heuristics (the issue title mentions this but the concrete ask is file-count based)
