# Pair Work (Coder)

Implement the task in `{{WORKTREE_PATH}}`.

Reviewer guidance:

{{PEER_REVIEW}}

If you create a PR, write it to `{{PR_FILE}}`.
If `{{INTERRUPT_FILE}}` appears, stop and write `interrupted`.

```sh
printf '%s|%s|coder work complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
