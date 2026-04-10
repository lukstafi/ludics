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

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
