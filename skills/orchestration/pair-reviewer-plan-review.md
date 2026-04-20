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

For data-shape changes (field extraction, JSON migration, section restructuring), check that downstream consumers are all identified with their required updates. Grep field names and section-header patterns to confirm nothing's missed; request changes if consumers are absent.

For every symbol or pattern the plan modifies, check that occurrences are enumerated project-wide — including inline reimplementations (regex patterns, copy-pasted logic), not just canonical function references. If something's missing, REQUEST_CHANGES and include the grep commands you ran plus the occurrences the plan missed.

On regression tests:
- Each behavior change (serialization, rendering, validation, CLI output) should have a named regression test.
- Tests are planned for the first implementation round, not deferred.

If behavior changes lack test coverage, REQUEST_CHANGES with specifics on what needs tests.

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
