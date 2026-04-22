# Pair Plan Review (Reviewer)

{{PROPOSAL_INSTRUCTION}}

## Code-Proposal Alignment

Check the merged plan against the proposal and the codebase:

- Does the plan's technical approach match the proposal's assumptions?
- Are the proposed code changes feasible as-is?
- If plan-merge found gaps, are they documented with ASSUMPTION GAP markers?

If alignment gaps remain, use REQUEST_CHANGES with a concrete remediation — for example:
- "Proposal needs revision to account for X."
- "Plan should add an intermediate refactoring step before Y."
- "Accept gap as known risk with rationale: Z."

## Reviewing the merged plan for `{{TASK_ID}}`

For data-shape changes (field extraction, JSON migration, section restructuring), check that downstream consumers are all identified with their required updates — shape changes break consumers in ways TypeScript doesn't catch. Grep field names and section-header patterns to confirm nothing's missed; REQUEST_CHANGES if consumers are absent. See [data-shape consumer sweep](../../docs/orchestration-patterns.md#data-shape-consumer-sweep) for what counts as a consumer.

For every symbol or pattern the plan modifies, check that occurrences are enumerated project-wide — including inline reimplementations (regex patterns, copy-pasted logic, string literals), not just canonical function references. A single-site change that misses a doppelganger reads next round as a partial fix. If something's missing, REQUEST_CHANGES and include the grep commands you ran plus the occurrences the plan missed. See [exhaustive occurrence search](../../docs/orchestration-patterns.md#exhaustive-occurrence-search).

On regression tests: each behaviour change (serialization, rendering, validation, CLI output) should have a named test planned for the first implementation round, not deferred — deferral drifts to abandonment. If behaviour changes lack test coverage, REQUEST_CHANGES with specifics on what needs tests. See [regression test per behaviour change](../../docs/orchestration-patterns.md#regression-test-per-behaviour-change).

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
