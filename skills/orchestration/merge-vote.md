# Merge Vote

Evaluate both candidate implementations and vote for the stronger branch.

Current votes:

{{MERGE_VOTES}}

Write only the winning agent name to `{{MERGE_VOTE_FILE}}`, then mark completion:

```sh
printf '%s|%s|merge vote written\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
