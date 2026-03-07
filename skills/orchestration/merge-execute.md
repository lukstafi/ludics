# Merge Execute

Integrate the losing branch's best ideas into the winner worktree.

Winner: `{{PEER_NAME}}`
Winner worktree: `{{PEER_WORKTREE_PATH}}`

Cherry-pick or manually port the useful pieces, test what you touch, and summarize the merge in `{{REVIEW_FILE}}`.

Then mark completion:

```sh
printf '%s|%s|merge execution complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
