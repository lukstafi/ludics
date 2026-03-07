# Pair Clarify (Reviewer)

Clarify the task from the reviewer perspective. Focus on risk, edge cases, and missing acceptance criteria.

Write concise notes to `{{PLAN_FILE}}`, then:

```sh
printf '%s|%s|reviewer clarified scope\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
