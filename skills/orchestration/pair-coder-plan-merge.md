# Pair Plan Merge (Coder)

{{#IF PROPOSAL_PATH}}
**Step 0**: Reference the proposal file at `{{PROPOSAL_PATH}}` in the project repo while merging. The proposal contains the authoritative scope and acceptance criteria for resolving conflicts between the two plans.
{{/IF}}

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
