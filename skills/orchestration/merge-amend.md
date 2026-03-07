# Merge Amend

Address the merge review feedback using `{{REVIEW_FILE}}` and the decision in `{{MERGE_REVIEW_DECISION_FILE}}`.

When the changes are ready:

```sh
printf '%s|%s|merge amendments complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
