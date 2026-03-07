# Plan Review

Review the peer plan before implementation starts.

Peer plan:

{{PEER_PLAN}}

If the plan is acceptable, include `APPROVE` near the top of `{{REVIEW_FILE}}`.
If not, include `REQUEST_CHANGES` and be specific.

Then mark completion:

```sh
printf '%s|%s|plan reviewed\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
