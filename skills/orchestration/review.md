# Review

Review the peer's implementation from your worktree context.

Peer status: `{{PEER_STATUS}}`
Peer worktree: `{{PEER_WORKTREE_PATH}}`

Structure your review as:
1. **Verdict**: `APPROVE` or `REQUEST_CHANGES` (first line)
2. **Action Items**: concrete changes needed (bullet list)
3. **Observations**: non-blocking notes, style suggestions, context for future rounds

Write to `{{REVIEW_FILE}}`. Keep action items clearly separated from observations so the coder can prioritize.

Then mark completion:

```sh
printf '%s|%s|review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
