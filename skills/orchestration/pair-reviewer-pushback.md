# Pair Pushback (Reviewer)

{{PROPOSAL_INSTRUCTION}}

Review the task critically and suggest improvements before coding continues.

Write pushback notes to `{{PLAN_FILE}}`, then:

```sh
printf '%s|%s|reviewer pushback complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
