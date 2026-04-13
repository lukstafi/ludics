# Pair Plan (Coder)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

**Baseline**: Run `bun test` now (before any code changes) and record every failing test name (exact name as reported by `bun test`) in the plan under a section titled `## Pre-existing test failures (baseline)`. If all tests pass, write `none`. Do not use vague summaries like "slot tests failing" — list each failing test individually. These failures will be treated as non-blocking by the reviewer unless the task's acceptance criteria explicitly require fixing them.

**Regression tests**: As you identify behavior changes in the plan (serialization formats, template variables, validation rules, CLI output, etc.), note what regression tests should accompany each change. These tests must be included in the **first implementation round** alongside the code changes — do not defer them to a later round. Examples:
- Changed serialization → round-trip test (serialize → deserialize → verify)
- New/changed template rendering → test that exercises the new variable/output
- Modified validation → test covering new rules and edge cases

Be concrete: files to change, expected behavior, edge cases, validation steps.
When the task changes data shapes (field extraction, JSON migration, section restructuring), explicitly list every downstream consumer of the affected data in the plan. For each consumer, note whether it needs updating and why. Grep for field names, section headers, and type references to ensure no consumer is missed.
Do not implement yet -- the reviewer is planning in parallel; plans will be merged next.

```sh
printf '%s|%s|coder plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
