# Gather

You are `{{AGENT_NAME}}` in phase `{{PHASE}}` for `{{FEATURE}}` at `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Collect codebase context, constraints, and risks needed for implementation. Write findings to `{{PLAN_FILE}}`.

```sh
printf '%s|%s|context gathered\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
