# Pair Plan Review (Reviewer)

Review the coder's plan:

{{PEER_PLAN}}

Write `APPROVE` or `REQUEST_CHANGES` in `{{REVIEW_FILE}}`, then:

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
