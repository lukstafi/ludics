# Pair Plan (Reviewer)

Produce your independent implementation plan for `{{FEATURE}}` from `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Write your plan to `{{PLAN_FILE}}`. Keep it concrete:
- Files to create or modify, with a brief description of each change
- Expected behaviour and any edge cases to handle
- Validation steps (build, tests, manual checks)

Do not start implementing yet — this is the planning step. You and the coder are each producing independent plans in parallel. After both plans are written, the coder will merge the two plans into a single best-of-both merged plan, which you will then review (APPROVE or REQUEST_CHANGES).

Then write:

```sh
printf '%s|%s|reviewer plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
