# Update Docs (Coder)

Capture durable learnings after round `{{ROUND}}`. Update `{{WORKFLOW_FEEDBACK_FILE}}` with feedback and summary. Keep `{{PR_FILE}}` accurate.

```sh
printf '%s|%s|docs updated\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
