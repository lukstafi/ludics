# Pair Plan Review (Reviewer)

{{PROPOSAL_INSTRUCTION}}

Review the merged plan for `{{TASK_ID}}`:

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` (with specific feedback) to `{{REVIEW_FILE}}`.

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
