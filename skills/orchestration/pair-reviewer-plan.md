# Pair Plan (Reviewer)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Use numbered lists for structured data; avoid wide tables (they get truncated between agents). Be concrete about files, expected behavior, edge cases, and validation steps.

As you plan, include a dedicated `## Regression Tests` section in your plan output. For each file that this round modifies with a behaviour change, list the regression test and its target test file using the format:

- `<file>` — <test description> (in `<test-file>`)

For files you modify but that carry no behaviour change, list them with an explicit justification using the format:

- `<file>` — No regression test needed — <reason>

Land the tests in the **first implementation round** — deferred tests drift to abandonment. See [regression test per behaviour change](../../docs/orchestration-patterns.md#regression-test-per-behaviour-change) for the common triggers.

This section is REQUIRED in your plan output. The plan-review step will REQUEST_CHANGES if it is missing.

Don't implement yet — the coder is planning in parallel and the two plans get merged next.

```sh
printf '%s|%s|reviewer plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
