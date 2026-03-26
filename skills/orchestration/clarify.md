# Clarify

You are `{{AGENT_NAME}}` (`{{AGENT_PROVIDER}}`) in `{{WORKTREE_PATH}}`.

{{TASK_SPEC}}

Peer status: `{{PEER_STATUS}}`

Identify ambiguities, hidden assumptions, and the best implementation direction. Write blocking questions to `{{PLAN_FILE}}`.

```sh
printf '%s|%s|clarified approach\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
