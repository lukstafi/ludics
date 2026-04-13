# Pair Plan Review (Reviewer)

{{PROPOSAL_INSTRUCTION}}

## Verify Code-Proposal Alignment

Check the merged plan against the proposal and actual codebase:

- [ ] Does the plan's technical approach match proposal assumptions?
- [ ] Are all proposed code changes feasible in the current codebase?
- [ ] If the plan-merge phase found gaps, are they documented with ASSUMPTION GAP markers?

If alignment gaps are found, use REQUEST_CHANGES with explicit remediation — for example:
- "Proposal needs revision to account for X"
- "Plan should add an intermediate refactoring step before Y"
- "Accept gap as known risk with rationale: Z"

Review the merged plan for `{{TASK_ID}}`:
If the plan involves data shape changes (field extraction, JSON migration, section restructuring), check that all downstream consumers of the changed data are identified and their required updates are noted. Request changes if consumers appear to be missing — grep for field names and section-header patterns to verify completeness.

When reviewing the plan, verify regression test coverage:
- Does each behavior change (serialization, rendering, validation, CLI output) have a corresponding regression test identified?
- Are the tests planned for the first implementation round, not deferred?

If behavior changes lack test coverage in the plan, `REQUEST_CHANGES` with specific feedback on which changes need regression tests.

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
