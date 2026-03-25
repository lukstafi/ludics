# Pair Plan (Coder)

Produce your independent implementation plan for `{{FEATURE}}` from `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Write your plan to `{{PLAN_FILE}}`. Keep it concrete:
- Files to create or modify, with a brief description of each change
- Expected behaviour and any edge cases to handle
- Validation steps (build, tests, manual checks)

Do not start implementing yet — this is the planning step only. The reviewer is producing an independent plan in parallel. After both plans are ready, you will merge them into a single best-of-both plan (plan-merge phase), which the reviewer will then formally review (APPROVE or REQUEST_CHANGES). Implementing begins only after the merged plan is approved.

Then write:

```sh
printf '%s|%s|coder plan written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
