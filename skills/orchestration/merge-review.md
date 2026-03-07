# Merge Review

Review the integrated winner branch after merge execution.

If the merge is acceptable, write `APPROVE` to `{{MERGE_REVIEW_DECISION_FILE}}`.
Otherwise write `REQUEST_CHANGES` there and explain the issues in `{{REVIEW_FILE}}`.

Then mark completion:

```sh
printf '%s|%s|merge review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
