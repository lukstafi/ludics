# Pair Gather

You are the reviewer. Gather the codebase context the coder should rely on.

Task spec:

{{TASK_SPEC}}

Write your findings to `{{PLAN_FILE}}`, then mark completion:

```sh
printf '%s|%s|reviewer context gathered\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
