# Proposal: Structural regression test guidance in plan templates

**Task**: gh-ludics-310
**Project**: ludics

## Goal

Replace the advisory regression test paragraph in `pair-coder-plan.md` with a structural `## Regression Tests` output section that agents must include in every plan, add regression test preservation instructions to the plan-merge template, strengthen the reviewer plan-review checklist to check for the structural section, and add equivalent guidance to the reviewer's own plan template (`pair-reviewer-plan.md`) so both plan candidates arrive pre-aligned on regression test coverage.

## Acceptance Criteria

### Layer 1: Structural section in coder plan template

1. In `skills/orchestration/pair-coder-plan.md`, the existing advisory paragraph about regression tests (the block starting "As you plan, call out the regression tests each behavior change needs" with its bullet examples) is replaced by an instruction that requires the plan output to contain a dedicated `## Regression Tests` section.
2. The new instruction specifies the expected format: for each modified file that involves a behavior change, list the regression test and its target test file; for files with no behavior-affecting change, write an explicit "No regression test needed" with a reason.
3. The instruction states that the reviewer will `REQUEST_CHANGES` if the section is missing, making the consequence explicit.

### Layer 2: Regression test preservation in plan-merge template

4. `skills/orchestration/pair-coder-plan-merge.md` gains a new instruction (after the merge instructions paragraph, before the status-file shell block) requiring the merged plan to include a `## Regression Tests` section that combines test items from both input plans.
5. The instruction directs the coder to enumerate regression tests for each behavior-affecting file change if neither input plan listed them.

### Layer 3: Strengthened reviewer plan-review checklist

6. In `skills/orchestration/pair-reviewer-plan-review.md`, the existing "On regression tests" checklist (the block with "Each behavior change ... should have a named regression test" and "Tests are planned for the first implementation round, not deferred") is replaced with a structural check: verify the merged plan contains a `## Regression Tests` section, and that it lists at least one test or explicit justification for each behavior-affecting file change.
7. The instruction to `REQUEST_CHANGES` for missing test coverage is preserved.

### Layer 4: Reviewer plan template alignment

8. `skills/orchestration/pair-reviewer-plan.md` gains regression test guidance equivalent to the coder plan template (acceptance criterion 1-3), requiring the reviewer's own plan output to include a `## Regression Tests` section with the same format expectations.
9. The guidance is placed after the existing body of instructions (after "Be concrete about files, expected behavior, edge cases, and validation steps.") and before the "Don't implement yet" closing line.

### Template rendering tests

10. Existing template rendering tests in `src/orchestration/skills.test.ts` continue to pass (the templates still render correctly with their placeholders).
11. No new runner-level tests are needed since no runner code is changed.

## Context

- **gh-ludics-219** (completed 2026-04-14) added advisory regression test guidance to three templates: `pair-coder-plan.md` (paragraph with bullet examples), `pair-coder-work.md` (bold inline instruction), and `pair-reviewer-plan-review.md` (reviewer checklist bullets). The plan-merge template and reviewer plan template were not touched.
- **gh-ludics-302** (completed 2026-04-15, one day after 219) demonstrated the continued failure: the coder's initial merged plan omitted regression tests despite the advisory guidance. The reviewer correctly caught it via `REQUEST_CHANGES`, causing an extra plan-merge round. The coder's retrospective explicitly stated: "The initial merged plan omitted template regression tests despite the task instructions explicitly calling for them."
- **Current template state**: `pair-coder-plan.md` has 4 lines of advisory text (the "As you plan..." paragraph and 3 bullet examples). `pair-coder-plan-merge.md` has zero regression test guidance. `pair-reviewer-plan-review.md` has a 4-line checklist under "On regression tests:". `pair-reviewer-plan.md` has no regression test guidance at all.
- **Design choice**: The user decided against programmatic validation (auto-prompting, plan content parsing). The structural template approach leverages the existing reviewer backstop while making the expectation impossible to overlook by requiring a named section heading in the output.
- **No changes to `pair-coder-work.md`**: The bold inline instruction added by gh-ludics-219 in the work template is adequate and out of scope.

## Approach

### In `pair-coder-plan.md`

Replace the advisory paragraph (starting "As you plan, call out the regression tests") and its 3 bullet examples with a new block that:
- Instructs the coder to include a `## Regression Tests` section in the plan output
- Specifies the per-file format: `- \`<file>\` -- <test description> (in \`<test-file>\`)`
- Requires explicit "No regression test needed -- <reason>" for files with no behavior change
- States: "This section is REQUIRED. The reviewer will REQUEST_CHANGES if it is missing."

### In `pair-coder-plan-merge.md`

Add a new paragraph after "Pick the strongest approach from each plan, fold in feedback, keep it concrete." and before the status-file shell block:

> **Regression tests**: The merged plan MUST include a `## Regression Tests` section. Combine test items from both plans. If neither plan lists regression tests, enumerate them now for each behavior-affecting file change.

### In `pair-reviewer-plan-review.md`

Replace the existing "On regression tests:" block (4 lines: the heading, two bullet items, and the `REQUEST_CHANGES` instruction) with a structural check:
- "Does the merged plan contain a `## Regression Tests` section?"
- "Does it list at least one test (or explicit 'no test needed' justification) for each behavior-affecting file change?"
- Preserve the existing `REQUEST_CHANGES` consequence for missing coverage.

### In `pair-reviewer-plan.md`

Add a new block after line 9 ("Be concrete about files, expected behavior, edge cases, and validation steps.") and before line 11 ("Don't implement yet"):

The block mirrors the coder plan template's structural requirement: include a `## Regression Tests` section in the plan output, with the same per-file format and explicit justification requirements.
