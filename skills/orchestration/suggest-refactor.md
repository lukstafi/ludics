# Suggest Refactor

Reflect on the completed work. Capture what you would do differently next time.

Write the reflection to `{{SUGGEST_REFACTOR_FILE}}`.

Then write:

```sh
printf '%s|%s|refactor notes captured\n' '{{DONE_STATUS}}' "$(date +%s)" > "{{STATUS_FILE}}"
```
