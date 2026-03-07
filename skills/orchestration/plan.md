# Plan

Produce an implementation plan for `{{FEATURE}}` from `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Write the plan to `{{PLAN_FILE}}`. Keep it concrete: files, expected behavior, validation.

Then write:

```sh
printf '%s|%s|plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
