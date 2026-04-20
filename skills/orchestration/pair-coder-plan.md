# Pair Plan (Coder)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Before any code changes, run `bun test` and record the exact failing test names (as reported by `bun test`) under a `## Pre-existing test failures (baseline)` section in the plan. Use `none` when all tests pass. List each failing test individually rather than summarizing — the reviewer treats these as non-blocking unless the acceptance criteria call for fixing them.

As you plan, call out the regression tests each behavior change needs (serialization formats, template variables, validation rules, CLI output, etc.) and land them in the **first implementation round**, not deferred. A few common patterns:
- Changed serialization → round-trip test (serialize → deserialize → verify).
- New/changed template rendering → a test that exercises the new variable/output.
- Modified validation → tests covering the new rules and edge cases.

Use numbered lists for structured data; avoid wide markdown tables (they get truncated between agents). Be concrete about files, expected behavior, edge cases, and validation steps.

When the task changes data shapes (field extraction, JSON migration, section restructuring), list every downstream consumer in the plan with a note on whether it needs updating. Grep field names, section headers, and type references to avoid missing one.

For every symbol, pattern, or function you plan to touch, run a project-wide grep/ripgrep and list occurrences in the plan with a disposition (modify / skip with reason / N/A). Search for inline reimplementations too — regex patterns, copy-pasted logic, and string literals that duplicate the same behavior.

Don't implement yet — the reviewer is planning in parallel and the two plans get merged next.

```sh
printf '%s|%s|coder plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
