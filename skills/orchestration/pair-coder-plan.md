# Pair Plan (Coder)

{{#IF PROPOSAL_PATH}}
**Step 0**: Read the proposal file at `{{PROPOSAL_PATH}}` in the project repo before starting. The proposal contains the authoritative acceptance criteria and full scope.
{{/IF}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Be concrete: files to change, expected behavior, edge cases, validation steps.
Do not implement yet -- the reviewer is planning in parallel; plans will be merged next.

```sh
printf '%s|%s|coder plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
