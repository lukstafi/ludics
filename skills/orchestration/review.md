# Review

Review the peer's implementation for `{{FEATURE}}`. If a proposal exists, read it for acceptance criteria: `{{PROPOSAL_PATH}}`.

Peer status: `{{PEER_STATUS}}`, worktree: `{{PEER_WORKTREE_PATH}}`.

Write to `{{REVIEW_FILE}}`: first line `APPROVE` or `REQUEST_CHANGES`, then action items (concrete), then non-blocking observations.

```sh
printf '%s|%s|review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
