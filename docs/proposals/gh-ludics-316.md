# Proposal: Acceptance criteria self-check before done signal

**Task**: gh-ludics-316
**Date**: 2026-04-20

## Goal

Ensure agents systematically verify every acceptance criterion before signaling done, and ensure reviewers explicitly check acceptance criteria as part of their review. This addresses the most common source of avoidable review rounds: agents signaling completion without confirming all criteria are met.

## Acceptance Criteria

1. `pair-coder-work.md` contains an AC verification instruction that fires regardless of whether `PROPOSAL_PATH` is set. When a proposal exists, it directs the coder to re-read the proposal file; when no proposal exists, it directs the coder to re-read the task spec from context.
2. The AC verification instruction requires the coder to produce a visible checklist (not just internal reasoning) -- written to the workflow feedback file -- listing each acceptance criterion and how the implementation satisfies it.
3. `pair-reviewer-review.md` contains an acceptance criteria verification section instructing the reviewer to walk through each acceptance criterion from the proposal (or task file) and verify the implementation satisfies it, treating unmet criteria as blocking action items.
4. A new `TASK_AC` template variable is added to `buildSkillContext()` in `skills.ts`, extracted from the task file's `## Acceptance Criteria` section, so AC text is available in all rounds (even when `TASK_SPEC` switches to brief form in round 2+).
5. The existing `{{#IF PROPOSAL_PATH}}` conditional block in `pair-coder-work.md` (the old AC check) is replaced by the new unconditional block. No duplicate AC instructions remain.
6. All existing tests pass. New tests cover: (a) `TASK_AC` variable extraction from task files, (b) `TASK_AC` is empty string when no AC section exists, (c) the unconditional AC block renders in work template both with and without `PROPOSAL_PATH`.

## Context

- **Evidence**: 6 retrospectives show agents who explicitly verified each criterion had single-round completions, while those who skipped verification needed extra rounds (task-6e388f07, gh-ludics-169, task-cdc68aa1, task-c8b663b4, task-decd52ed, task-f3b6e620).
- **Current gap 1**: The AC verification block in `pair-coder-work.md` (line 23-25) is inside `{{#IF PROPOSAL_PATH}}`, so tasks without proposals get no AC verification instruction at all.
- **Current gap 2**: The instruction says "state explicitly (in your thinking)" which produces no visible artifact -- the reviewer and orchestrator cannot confirm AC verification happened.
- **Current gap 3**: `pair-reviewer-review.md` has no systematic AC check. Reviewers catch AC violations only incidentally through general code review.
- **Current gap 4**: In round 2+, `TASK_SPEC` switches to brief form (`taskSpecBriefText`) which omits the AC section entirely. The coder is told to "re-read if you need to verify" but the AC text is not directly available.
- **Relationship to gh-ludics-305** (scope enforcement): Orthogonal -- that issue is about file-scope boundaries, not AC verification.
- **Relationship to gh-ludics-311** (proposal drift): Complementary -- drift detection ensures proposal assumptions are correct; this ensures the agent checks criteria before signaling done.
- **Relationship to gh-ludics-312** (caller audit): Non-overlapping -- that issue adds caller-audit instructions; this adds AC self-check instructions. Both modify the same template files but target different paragraphs.

## Approach

### 1. Add `TASK_AC` template variable in `skills.ts`

Add a helper function `extractAcceptanceCriteria(taskId: string): string` that:
- Reads the task file from `tasks/{taskId}.md`
- Extracts the content under `## Acceptance Criteria` (up to the next `##` heading or end of file)
- Returns the extracted text, or empty string if the section doesn't exist or is just `- [ ] TBD`

Add `TASK_AC` to the `result` record in `buildSkillContext()`, populated by this helper. This makes AC available in every phase and every round, independent of `TASK_SPEC` brief/full switching.

### 2. Replace conditional AC block in `pair-coder-work.md`

Remove the existing `{{#IF PROPOSAL_PATH}}...{{/IF}}` block (lines 23-25) and replace it with an unconditional AC verification section:

```markdown
## Acceptance Criteria Self-Check

Before signaling done, verify every acceptance criterion is met:

{{#IF PROPOSAL_PATH}}
1. Re-read `{{PROPOSAL_PATH}}` in the project repo for the authoritative acceptance criteria.
{{/IF}}
{{#IF TASK_AC}}
Task acceptance criteria:
{{TASK_AC}}
{{/IF}}

For each criterion, write a one-line confirmation to `{{WORKFLOW_FEEDBACK_FILE}}` under a `## AC Verification` heading, stating how the implementation satisfies it. Only write the done status file after confirming every criterion.
```

This fires for all tasks. When `PROPOSAL_PATH` exists, it directs the agent to re-read the proposal (which may have more detailed AC). When `TASK_AC` is available, it shows the criteria inline so the agent doesn't need to re-read the task file. The checklist is written to the workflow feedback file, making it visible to the reviewer and auditable in retrospectives.

### 3. Add AC verification section to `pair-reviewer-review.md`

Insert after the existing data-shapes paragraph (line 9) and before the "Before treating a failing test..." paragraph:

```markdown
### Acceptance Criteria Verification

Walk through each acceptance criterion from the proposal or task file and verify the implementation satisfies it. Unmet criteria are blocking action items.

{{#IF PROPOSAL_PATH}}
Re-read `{{PROPOSAL_PATH}}` for the authoritative acceptance criteria.
{{/IF}}
{{#IF TASK_AC}}
Task acceptance criteria:
{{TASK_AC}}
{{/IF}}
```

This creates a second checkpoint. Even if the coder's self-check was thorough, the reviewer independently verifies each criterion.

### 4. Update tests in `skills.test.ts`

Add tests:
- `TASK_AC` extraction from a task file with an `## Acceptance Criteria` section returns the criteria text.
- `TASK_AC` is empty string when the task file has no AC section or only `- [ ] TBD`.
- Work template unconditional AC block renders when `PROPOSAL_PATH` is empty (verifying the old conditional gap is closed).
- Work template AC block includes proposal re-read instruction when `PROPOSAL_PATH` is set.
- Review template AC section renders with `TASK_AC` content.
- Add `TASK_AC` to the `baseCtx()` helper so existing tests don't warn about missing variable.

### Key files

| File | Change |
|------|--------|
| `src/orchestration/skills.ts` | Add `extractAcceptanceCriteria()` helper, add `TASK_AC` to `buildSkillContext()` |
| `skills/orchestration/pair-coder-work.md` | Replace conditional AC block with unconditional self-check section |
| `skills/orchestration/pair-reviewer-review.md` | Add AC verification section |
| `src/orchestration/skills.test.ts` | Add tests for `TASK_AC` extraction and unconditional AC rendering |

### Scope exclusions

- **`update-docs` and `final-merge` templates**: These phases are post-review -- AC verification at work+review time is sufficient. Adding AC checks to every phase would be noise.
- **Structured JSON output for AC verification**: The workflow feedback file is sufficient as a visible artifact. Structured output fields would require runtime parsing changes for marginal benefit.
- **Extracting AC from proposal files**: The proposal file is already read via `PROPOSAL_INSTRUCTION` / `PROPOSAL_PATH`. Parsing proposal AC into a separate variable would duplicate the "re-read proposal" instruction. The `TASK_AC` variable covers the task-file AC, which is the fallback for tasks without proposals.
- **Changes to `pair-coder-plan.md` or `pair-reviewer-plan-review.md`**: AC verification belongs at work-completion time, not planning time. Plans are about *how* to satisfy criteria, not *whether* they are satisfied.
