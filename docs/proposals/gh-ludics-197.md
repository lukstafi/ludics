# Proposal: Baseline test failures before starting work

**Task**: gh-ludics-197

## Goal

Add a baseline test-run step to the coder plan template so that pre-existing test failures are recorded before implementation begins, and add corresponding reviewer guidance to treat baselined failures as non-blocking. This eliminates wasted review rounds caused by reviewers correctly flagging pre-existing failures as blocking.

## Acceptance Criteria

1. `skills/orchestration/pair-coder-plan.md` includes an explicit step instructing the coder to run `bun test` on the current branch before writing the plan and to record all failing test names in the plan file under a "Pre-existing test failures (baseline)" section.
2. `skills/orchestration/pair-reviewer-review.md` includes an instruction to consult the baseline section of the merged plan; failures listed there must not be treated as blocking unless the task acceptance criteria explicitly require fixing them.
3. `skills/orchestration/pair-reviewer-gather.md` includes an analogous baseline test-run step so the reviewer can cross-check the coder's recorded baseline independently.
4. The plan file format guidance (in `pair-coder-plan.md`) specifies that the baseline section must list exact test names (as reported by `bun test`) or state "none" if all tests pass — no vague prose.
5. All existing tests pass (`bun test`) — the templates are plain text and do not affect test outcomes.
6. Build succeeds (`bun run build`).

## Context

Three concrete incidents from issue #197:
- **gh-ludics-169**: 3 wasted review rounds because `src/slots/index.test.ts` and `src/t3code/client.test.ts` failures were not baselined. The reviewer could not distinguish them from regressions.
- **gh-ludics-186**: Reviewer flagged a pre-existing `heartbeatIsFresh` remote-slot test as blocking acceptance criterion 6. A fix on `main` (commit `038eb4d`) was not cherry-picked into the branch's merge base.
- **task-e94f5fbb**: Unrelated broken phases/slots tests blocked review even though the task scope was tmux-capture only.

The root cause in all cases is that the orchestration pipeline has no step anywhere that captures the test state before implementation begins. The coder's `pair-coder-plan.md` says "be concrete: files to change, expected behavior, edge cases, validation steps" but does not mention running tests first. The reviewer's `pair-reviewer-review.md` says nothing about pre-existing failures.

### Files to change

- `skills/orchestration/pair-coder-plan.md` — add baseline test-run step before plan writing
- `skills/orchestration/pair-reviewer-gather.md` — add baseline test-run step for cross-check
- `skills/orchestration/pair-reviewer-review.md` — add guidance to treat baselined failures as non-blocking

### Out of scope

Adding `bun test` to CI (`.github/workflows/ci.yml`) is complementary but orthogonal. It may introduce flaky-test noise and does not address the reviewer's inability to distinguish pre-existing from new failures. It is deferred.

## Approach

All three template edits are small and independent.

1. **`pair-coder-plan.md`**: Before the existing "Be concrete…" instruction, insert:

   > **Step 0 — Baseline**: Run `bun test` now (before any code changes) and record every failing test name in the plan under a section titled `## Pre-existing test failures (baseline)`. If all tests pass, write `none`. These failures will be treated as non-blocking by the reviewer unless the task's acceptance criteria require fixing them.

2. **`pair-reviewer-gather.md`**: After the "Gather the codebase context" instruction, insert:

   > **Baseline cross-check**: Run `bun test` and record failing test names in your findings. Note any discrepancy with the coder's baseline (from the merged plan).

3. **`pair-reviewer-review.md`**: After the `APPROVE / REQUEST_CHANGES` instruction, insert:

   > **Pre-existing failures**: Before marking any failing test as a blocking action item, check the merged plan's `## Pre-existing test failures (baseline)` section. Failures listed there are pre-existing and must not block acceptance unless the task explicitly targets them. Flag any new failures (not in the baseline) as blocking.
