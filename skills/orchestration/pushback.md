# Pushback

Review the task critically. Suggest any spec improvements, safer scope cuts, or missing acceptance criteria.

Task spec:

{{TASK_SPEC}}

Write your pushback note to `{{PLAN_FILE}}`, then mark completion:

```sh
printf '%s|%s|pushback written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
