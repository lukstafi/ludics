# Pair Review (Reviewer)

Review the coder's implementation for `{{FEATURE}}`. If a proposal exists, read it for acceptance criteria: `{{PROPOSAL_PATH}}`.

Write to `{{REVIEW_FILE}}`: first line `APPROVE` or `REQUEST_CHANGES`, then action items, then non-blocking observations.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
