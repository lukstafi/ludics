# Merge Debate

Reconsider the merge decision in light of the current votes:

{{MERGE_VOTES}}

Update `{{MERGE_VOTE_FILE}}` with your final winner choice, then write:

```sh
printf '%s|%s|merge debate complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
