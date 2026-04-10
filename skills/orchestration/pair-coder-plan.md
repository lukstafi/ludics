# Pair Plan (Coder)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

**Baseline**: Run `bun test` now (before any code changes) and record every failing test name (exact name as reported by `bun test`) in the plan under a section titled `## Pre-existing test failures (baseline)`. If all tests pass, write `none`. Do not use vague summaries like "slot tests failing" — list each failing test individually. These failures will be treated as non-blocking by the reviewer unless the task's acceptance criteria explicitly require fixing them.

Be concrete: files to change, expected behavior, edge cases, validation steps.
When the task changes data shapes (field extraction, JSON migration, section restructuring), explicitly list every downstream consumer of the affected data in the plan. For each consumer, note whether it needs updating and why. Grep for field names, section headers, and type references to ensure no consumer is missed.
Do not implement yet -- the reviewer is planning in parallel; plans will be merged next.

```sh
printf '%s|%s|coder plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
