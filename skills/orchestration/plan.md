# Plan

{{#IF PROPOSAL_PATH}}
**Step 0**: Read the proposal file at `{{PROPOSAL_PATH}}` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.
{{/IF}}

Produce an implementation plan for `{{TASK_ID}}` from `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Write the plan to `{{PLAN_FILE}}`. Keep it concrete: files, expected behavior, validation.

Then write:

```sh
printf '%s|%s|plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
