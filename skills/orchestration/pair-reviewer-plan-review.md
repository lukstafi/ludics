# Pair Plan Review (Reviewer)

{{PROPOSAL_INSTRUCTION}}

Review the merged plan for `{{TASK_ID}}`:
If the plan involves data shape changes (field extraction, JSON migration, section restructuring), check that all downstream consumers of the changed data are identified and their required updates are noted. Request changes if consumers appear to be missing — grep for field names and section-header patterns to verify completeness.

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
