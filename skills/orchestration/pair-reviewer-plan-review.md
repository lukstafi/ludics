# Pair Plan Review (Reviewer)

{{PROPOSAL_INSTRUCTION}}

## Code-Proposal Alignment

Check the merged plan against the proposal and the codebase:

- Does the plan's technical approach match the proposal's assumptions?
- Are the proposed code changes feasible as-is?
- If plan-merge found gaps, are they documented with ASSUMPTION GAP markers?

{{#IF PROPOSAL_PATH}}
- **Scope declarations**: are all out-of-scope files in the merged plan accompanied by a one-line scope-expansion justification? Flag missing justifications. Scope itself is not a blocker; undeclared expansions are a discipline issue. When in doubt on a feature branch that may be stale, prefer `git log main..HEAD --stat` for a per-commit summary and `git diff <commit>^..<commit> --stat` for each merge's actual change — deletions visible in `main..HEAD` but absent from per-commit diffs are main-side drift, not scope violations; rebase and re-check before flagging scope. See [scope declaration and salvage](../../docs/orchestration-patterns.md#scope-declaration-and-salvage).
{{/IF}}

If alignment gaps remain, use REQUEST_CHANGES with a concrete remediation — for example:
- "Proposal needs revision to account for X."
- "Plan should add an intermediate refactoring step before Y."
- "Accept gap as known risk with rationale: Z."

## Reviewing the merged plan for `{{TASK_ID}}`

For data-shape changes (field extraction, JSON migration, section restructuring), check that downstream consumers are all identified with their required updates — shape changes break consumers in ways TypeScript doesn't catch. Grep field names and section-header patterns to confirm nothing's missed; REQUEST_CHANGES if consumers are absent. See [data-shape consumer sweep](../../docs/orchestration-patterns.md#data-shape-consumer-sweep) for what counts as a consumer. If the plan adds a new optional field on a persisted shape, it must name the read-boundary backfill location (e.g. `migrateState`, `parseTaskFrontmatter`); REQUEST_CHANGES if construction-site population is the only mechanism, since legacy and test-constructed instances stay non-normalized — see [read-boundary backfill for optional fields](../../docs/orchestration-patterns.md#read-boundary-backfill-for-optional-fields).

For every symbol or pattern the plan modifies, check that occurrences are enumerated project-wide — including inline reimplementations (regex patterns, copy-pasted logic, string literals), not just canonical function references. A single-site change that misses a doppelganger reads next round as a partial fix. If something's missing, REQUEST_CHANGES and include the grep commands you ran plus the occurrences the plan missed. See [exhaustive occurrence search](../../docs/orchestration-patterns.md#exhaustive-occurrence-search).

On regression tests, verify the merged plan structurally:

- Does the merged plan contain a top-level `## Regression Tests` section?
- Does that section list at least one named test (or an explicit "No regression test needed — <reason>" justification) for each behaviour-affecting file change enumerated elsewhere in the plan?

If the section is missing, or if a behaviour-affecting change has no corresponding test entry and no explicit justification, REQUEST_CHANGES with specifics on what needs tests. Deferred tests drift to abandonment — require them in the first implementation round. See [regression test per behaviour change](../../docs/orchestration-patterns.md#regression-test-per-behaviour-change).

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
