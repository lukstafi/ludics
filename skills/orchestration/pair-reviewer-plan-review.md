# Pair Plan Review (Reviewer)

Review the merged implementation plan for `{{FEATURE}}`:

{{PEER_PLAN}}

Evaluate the plan for:
- Correctness: does it address the task spec fully?
- Completeness: are all affected files identified?
- Approach: is the chosen design sound and free of obvious pitfalls?
- Validation: are the build/test steps sufficient?

Write your verdict and comments to `{{REVIEW_FILE}}`:
- If the plan is sound, write `APPROVE` followed by any minor notes.
- If the plan needs changes, write `REQUEST_CHANGES` followed by specific, actionable feedback describing what must be improved before work begins.

Then write:

```sh
printf '%s|%s|reviewer plan verdict complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
