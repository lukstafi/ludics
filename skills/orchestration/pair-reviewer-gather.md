# Pair Gather

{{PROPOSAL_INSTRUCTION}}

You are the reviewer. Gather the codebase context the coder should rely on.

Task spec:

{{TASK_SPEC}}

**Baseline cross-check**: Run `bun test` and record every failing test name (exact names) in your findings. Compare against the coder's baseline from the merged plan and explicitly note any discrepancies — do not silently override the coder's baseline. Discrepancies are typically caused by different merge bases or environment-sensitive tests.

Write your findings to `{{PLAN_FILE}}`, then mark completion:

```sh
printf '%s|%s|reviewer context gathered\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
