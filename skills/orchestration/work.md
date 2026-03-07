# Work

Implement the task in `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Peer review from prior round:

{{PEER_REVIEW}}

Rules:
- Stay inside `{{WORKTREE_PATH}}`.
- If `{{INTERRUPT_FILE}}` appears, stop promptly and write `interrupted`.
- If you open a PR, write its URL to `{{PR_FILE}}`.

When the round is done:

```sh
printf '%s|%s|implementation complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
