# Pair Gather

{{PROPOSAL_INSTRUCTION}}

You are the reviewer. Gather the codebase context the coder should rely on.

Task spec:

{{TASK_SPEC}}

Run `bun test` and record every failing test name (exact names) in your findings. Cross-check against the coder's baseline in the merged plan and call out any discrepancies rather than silently overriding the baseline — mismatches usually come from different merge bases or environment-sensitive tests.

Write your findings to `{{PLAN_FILE}}`, then mark completion:

```sh
printf '%s|%s|reviewer context gathered\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
