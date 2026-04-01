# Pair Review (Reviewer) — Round {{ROUND}}

Review the coder's implementation for `{{FEATURE}}`. If a proposal exists, read it for acceptance criteria: `{{PROPOSAL_PATH}}`.

**IMPORTANT**: Write your review to exactly this file path: `{{REVIEW_FILE}}`
First line must be `APPROVE` or `REQUEST_CHANGES`, then action items, then non-blocking observations.
Do NOT write to a different filename — the orchestrator checks this exact path.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
