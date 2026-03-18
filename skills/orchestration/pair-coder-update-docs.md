# Update Docs (Coder)

Capture durable learnings after round `{{ROUND}}`.

- Update `{{WORKFLOW_FEEDBACK_FILE}}` with process/tooling feedback.
- If you have a concise implementation summary, append it there too.
- If a PR is already open, keep `{{PR_FILE}}` accurate.

Finish with:

```sh
printf '%s|%s|docs updated\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
