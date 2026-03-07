# Pair Review (Reviewer)

Review the coder's implementation and record a clear verdict.

Write `APPROVE` or `REQUEST_CHANGES` in `{{REVIEW_FILE}}`, then:

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
