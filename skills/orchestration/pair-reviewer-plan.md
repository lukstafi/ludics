# Pair Plan (Reviewer)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

**Formatting**: Use numbered lists for structured data in your plan. Do not use wide markdown tables — they get truncated when passed between agents.
Be concrete: files to change, expected behavior, edge cases, validation steps.
Do not implement yet -- the coder is planning in parallel; plans will be merged next.

```sh
printf '%s|%s|reviewer plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
