# Review

Review the peer's implementation from your worktree context.

Peer status: `{{PEER_STATUS}}`
Peer worktree: `{{PEER_WORKTREE_PATH}}`

Write review notes to `{{REVIEW_FILE}}`. Use `APPROVE` or `REQUEST_CHANGES` near the top.

Then mark completion:

```sh
printf '%s|%s|review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
