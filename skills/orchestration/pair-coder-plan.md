# Pair Plan (Coder)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Before any code changes, run `bun test` and record the exact failing test names under a `## Pre-existing test failures (baseline)` section in the plan (use `none` when clean). The reviewer treats this list as the non-blocking backdrop for the review — see [pre-existing failures baseline](../../docs/orchestration-patterns.md#pre-existing-failures-baseline) for how the list is used and what to write when planning was skipped.

As you plan, include a dedicated `## Regression Tests` section in the plan output. For each file that this round modifies with a behaviour change, list the regression test and its target test file using the format:

- `<file>` — <test description> (in `<test-file>`)

For files you modify but that carry no behaviour change (pure refactor, doc-only edit, template reformatting with no rendered-output difference), list them with an explicit justification using the format:

- `<file>` — No regression test needed — <reason>

Land the tests in the **first implementation round** — deferred tests drift to abandonment. See [regression test per behaviour change](../../docs/orchestration-patterns.md#regression-test-per-behaviour-change) for the common triggers (serialization, template rendering, validation, CLI output).

This section is REQUIRED. The reviewer will REQUEST_CHANGES if it is missing.

Use numbered lists for structured data; avoid wide markdown tables — they get truncated between agents and right-hand columns silently vanish. Be concrete about files, expected behavior, edge cases, and validation steps.

When the task changes data shapes (field extraction, JSON migration, section restructuring), list every downstream consumer in the plan with a note on whether it needs updating — shape changes break consumers in ways TypeScript doesn't catch. See [data-shape consumer sweep](../../docs/orchestration-patterns.md#data-shape-consumer-sweep) for what counts as a consumer.

For every symbol, pattern, or function you plan to touch, run a project-wide grep/ripgrep and list occurrences with a disposition (modify / skip with reason / N/A). Canonical-name search alone misses inline reimplementations — regex patterns, copy-pasted logic, string literals that duplicate the same behavior — and the bug looks like a partial fix the next round. See [exhaustive occurrence search](../../docs/orchestration-patterns.md#exhaustive-occurrence-search) for the disposition-list shape.

{{#IF PROPOSAL_PATH}}
**Scope declaration**: Cross-reference your file list against the `## Scope` section of the proposal at `{{PROPOSAL_PATH}}`. If the plan includes any out-of-scope files, list them explicitly as scope expansions with a one-line justification each — the reviewer will decide per-expansion whether to accept or redirect to a follow-up task. See [scope declaration and salvage](../../docs/orchestration-patterns.md#scope-declaration-and-salvage).
{{/IF}}

Don't implement yet — the reviewer is planning in parallel and the two plans get merged next.

```sh
printf '%s|%s|coder plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
