# Update Docs

Capture durable learnings after round `{{ROUND}}`.

Update `{{WORKFLOW_FEEDBACK_FILE}}` with process/tooling feedback and implementation summary.
Keep `{{PR_FILE}}` accurate. Update architecture docs if code was restructured.

```sh
printf '%s|%s|docs updated\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
