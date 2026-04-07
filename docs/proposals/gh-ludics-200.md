# Proposal: Add acceptance criteria checklist before coder marks done

## Goal

Prevent coder agents from emitting the `done` status without first verifying each acceptance criterion. Add a pre-done checklist instruction to `skills/orchestration/pair-coder-work.md` that fires immediately before the status-file write command, using the existing `{{#IF PROPOSAL_PATH}}` conditional infrastructure.

Ref: https://github.com/lukstafi/ludics/issues/200

## Acceptance Criteria

1. `skills/orchestration/pair-coder-work.md` contains a new conditional block, placed immediately before the `printf` status-file command, that instructs the coder to open `{{PROPOSAL_PATH}}`, read each acceptance criterion, and explicitly confirm it is met before writing the status file.
2. The block is guarded by `{{#IF PROPOSAL_PATH}}...{{/IF}}` so it only appears when a file-based proposal exists; tasks without a file-based proposal are unaffected.
3. No other template files are changed (planning-phase templates and reviewer templates are out of scope).
4. No TypeScript changes are made; the existing `substituteTemplate()` conditional engine handles the new block without modification.
5. All existing tests pass.

## Context

### Failure pattern

Three separate tasks (task-5d813109, task-652d009f, task-6e388f07) showed coders emitting `done` without checking acceptance criteria, causing avoidable reviewer round-trips. The reviewer's recurring feedback was: "Read acceptance criteria line-by-line before marking done."

### Current template (`skills/orchestration/pair-coder-work.md`)

```markdown
# Pair Work (Coder)

{{PROPOSAL_INSTRUCTION}}

Implement the task in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Reviewer guidance from prior round:

{{PEER_REVIEW}}

Commit in small batches (4-6 files). Build, lint, and run targeted tests before signaling done.
Write any PR URL to `{{PR_FILE}}`. Stop if `{{INTERRUPT_FILE}}` appears.

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
```

`{{PROPOSAL_INSTRUCTION}}` (added by gh-ludics-139) tells the coder to read the proposal at the start. The gap is that there is no analogous instruction at the end — the coder can forget the criteria by the time it reaches the `printf` command.

### Template engine support

`substituteTemplate()` in `src/orchestration/skills.ts` (line ~318) already supports `{{#IF VAR}}...{{/IF}}`. Both `PROPOSAL_PATH` and `PROPOSAL_INSTRUCTION` are populated by `buildTemplateVars()` (lines ~251–267). No engine changes are needed.

### Scope rationale

- Only the work phase requires this change: the coder is the only agent that writes a work-phase done status.
- Planning templates (`pair-coder-plan.md`, `pair-coder-plan-merge.md`) relate to acceptance criteria indirectly; plan correctness is already validated by the reviewer's plan-review phase.
- When `proposal: inline` (no `PROPOSAL_PATH`), the acceptance criteria are already present in `{{TASK_SPEC}}` — the inline case is lower priority and out of scope here.

## Approach

Edit `skills/orchestration/pair-coder-work.md` to insert the following block immediately before the shell code block:

```
{{#IF PROPOSAL_PATH}}
**Before signaling done**: Re-open `{{PROPOSAL_PATH}}` and read each acceptance criterion.
For each criterion, state explicitly (in your thinking) how the implementation satisfies it.
Only after confirming every criterion is met should you write the status file below.
{{/IF}}
```

The insertion point is after "Build, lint, and run targeted tests before signaling done." and before the closing `printf` shell block — the last thing the agent reads before committing to the done signal.

### Files to change

| File | Change |
|------|--------|
| `skills/orchestration/pair-coder-work.md` | Add pre-done checklist conditional block |
