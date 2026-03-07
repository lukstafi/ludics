# Clarify

You are `{{AGENT_NAME}}` (`{{AGENT_PROVIDER}}`) in `{{WORKTREE_PATH}}`.

Task spec:

{{TASK_SPEC}}

Peer status: `{{PEER_STATUS}}`

Identify ambiguities, hidden assumptions, and the best implementation direction. If a question is blocking, state it explicitly in `{{PLAN_FILE}}`.

When finished:

```sh
printf '%s|%s|clarified approach\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
