# Pair Plan (Reviewer)

{{PROPOSAL_INSTRUCTION}}

Write an implementation plan for `{{TASK_ID}}` to `{{PLAN_FILE}}` from `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Use numbered lists for structured data; avoid wide tables (they get truncated between agents). Be concrete about files, expected behavior, edge cases, and validation steps.

Don't implement yet — the coder is planning in parallel and the two plans get merged next.

```sh
printf '%s|%s|reviewer plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
