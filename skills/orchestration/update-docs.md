# Update Docs

Capture durable learnings after round `{{ROUND}}`.

- Update `{{WORKFLOW_FEEDBACK_FILE}}` with process/tooling feedback.
- If you have a concise implementation summary, append it there too.
- If a PR is already open, keep `{{PR_FILE}}` accurate.
- If you restructured code, update architecture docs (ARCHITECTURE.md, README relevant sections).
- For multi-item commits, use one logical commit per distinct change — don't bundle unrelated items.

Shell note: when writing file paths in heredocs, use double-quoted heredocs (`<<EOF`) to expand variables, not single-quoted (`<<'EOF'`).

Finish with:

```sh
printf '%s|%s|docs updated\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
