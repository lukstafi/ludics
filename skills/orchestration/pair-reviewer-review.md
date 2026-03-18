# Pair Review (Reviewer)

Review the coder's implementation and record a clear verdict.

Structure your review as:
1. **Verdict**: `APPROVE` or `REQUEST_CHANGES` (first line)
2. **Action Items**: concrete changes needed (bullet list)
3. **Observations**: non-blocking notes, style suggestions, context for future rounds

Write to `{{REVIEW_FILE}}`. Keep action items clearly separated from observations so the coder can prioritize.

```sh
printf '%s|%s|reviewer work review complete\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
