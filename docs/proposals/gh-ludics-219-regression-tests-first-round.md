# Proposal: Agents should include regression tests in first implementation round

**Task**: gh-ludics-219
**Date**: 2026-04-09

## Goal

Update orchestration templates to explicitly instruct coder agents to include regression tests for changed behaviors in the first implementation round, and instruct reviewers to check for this during plan review. This eliminates the most common source of unnecessary second review rounds.

## Acceptance Criteria

1. `pair-coder-plan.md` includes a "Regression Test Planning" section (after the baseline test recording block) that instructs coders to identify needed regression tests during planning, with concrete examples (serialization round-trip, template rendering, validation edge cases).
2. `pair-coder-work.md` updates the commit instruction line to explicitly require regression tests in the same batch as implementation changes.
3. `pair-reviewer-plan-review.md` adds a test coverage checklist that reviewers must verify before approving a plan — specifically checking that behavior changes have corresponding regression tests planned for the first round.
4. New instructions are clearly distinct from the existing baseline test recording guidance (commit 01f9486) — baseline = pre-existing failures, regression = new tests for changed behavior.
5. No duplicate or conflicting instructions introduced.

## Context

- **Recurring pattern**: Across task-9d30442b, task-0287a963, and gh-ludics-167, reviewers consistently requested regression tests that were omitted from the first round. Each omission added an extra review cycle.
- **Existing baseline guidance**: Commit 01f9486 (April 7) added baseline test failure recording to `pair-coder-plan.md` and reviewer templates. The new regression test guidance is complementary, not overlapping — baseline captures pre-existing failures; regression tests cover newly changed behavior.
- **Three template files** in `skills/orchestration/`:
  - `pair-coder-plan.md` — currently 17 lines, ends with baseline test instructions then the status printf
  - `pair-coder-work.md` — currently 25 lines, commit instruction on line 13
  - `pair-reviewer-plan-review.md` — currently 13 lines, minimal structure (review merged plan, write verdict)

## Approach

### 1. `pair-coder-plan.md` — Add regression test planning section

Insert after the baseline test recording paragraph (line 9) and before the "Be concrete" line (line 11):

```markdown
**Regression tests**: As you identify behavior changes in the plan (serialization formats, template variables, validation rules, CLI output, etc.), note what regression tests should accompany each change. These tests must be included in the **first implementation round** alongside the code changes — do not defer them to a later round. Examples:
- Changed serialization → round-trip test (serialize → deserialize → verify)
- New/changed template rendering → test that exercises the new variable/output
- Modified validation → test covering new rules and edge cases
```

### 2. `pair-coder-work.md` — Update commit instruction

Change line 13 from:
```
Commit in small batches (4-6 files). Build, lint, and run targeted tests before signaling done.
```
To:
```
Commit in small batches (4-6 files). **For each behavior change, include a regression test in the same batch.** Build, lint, and run targeted tests before signaling done.
```

### 3. `pair-reviewer-plan-review.md` — Add test coverage checklist

Insert before the status printf block:

```markdown
When reviewing the plan, verify regression test coverage:
- Does each behavior change (serialization, rendering, validation, CLI output) have a corresponding regression test identified?
- Are the tests planned for the first implementation round, not deferred?

If behavior changes lack test coverage in the plan, `REQUEST_CHANGES` with specific feedback on which changes need regression tests.
```
