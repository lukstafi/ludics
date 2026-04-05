# Pair Plan Merge (Coder)

{{PROPOSAL_INSTRUCTION}}

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
