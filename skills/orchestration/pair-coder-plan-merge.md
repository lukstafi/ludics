# Pair Plan Merge (Coder)

{{PROPOSAL_INSTRUCTION}}

## Code-Proposal Alignment Checklist

Before merging the plans, verify that the proposal's code assumptions match the actual codebase in this worktree. Use grep, search, or type-check to confirm each item:

- [ ] APIs/functions mentioned in the proposal exist in the codebase
- [ ] Function/module signatures match proposal expectations
- [ ] Data structures (types, interfaces) exist as assumed
- [ ] File paths referenced in the proposal point to actual files
- [ ] Dependencies mentioned in the proposal are available
- [ ] If the proposal assumes code added by prior phases, confirm it is present

If any assumption is violated, document the gap in the merged plan:
"⚠️ ASSUMPTION GAP: proposal assumes X but codebase has Y. Recommend [specific remediation]."

Minor gaps (e.g., a renamed method with identical behavior): document clearly but proceed with the merge.
Substantial gaps (e.g., an entire API or module is missing, would cause implementation rework): reassign to reviewer with REQUEST_CHANGES.

Merge the two independent plans for `{{TASK_ID}}` into one at `{{MERGED_PLAN_FILE}}`.

**Your plan**: `{{PLAN_FILE}}`

**Reviewer's plan**:

{{PEER_PLAN}}

**Reviewer's feedback on previous merge** (if any):

{{PEER_REVIEW}}

Pick the strongest approach from each, incorporate feedback, stay concrete.

```sh
printf '%s|%s|merged plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
