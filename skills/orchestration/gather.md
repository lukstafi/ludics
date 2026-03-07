# Gather

You are `{{AGENT_NAME}}` in phase `{{PHASE}}` for feature `{{FEATURE}}`.
Worktree: `{{WORKTREE_PATH}}`

Task context:

{{TASK_SPEC}}

Collect missing codebase context, constraints, and risks. Focus on what the implementation phase needs next.

Write a short note to `{{PLAN_FILE}}`.
When finished, update `{{STATUS_FILE}}` with:

```sh
printf '%s|%s|context gathered\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
