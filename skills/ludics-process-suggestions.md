---
name: ludics-process-suggestions
description: Process retrospective suggestions into needs-confirmation tasks
queue-action: process-suggestions
queue-args: [task]
queue-required-args: [task]
---

# /ludics-process-suggestions - Process Retrospective Suggestions

Process a completed task's retrospective to create follow-up tasks from
substantive suggestions. Nitpicky suggestions are skipped with reasoning.

## Trigger

Auto-queued after retrospective collection for a completed task.
Manual: `ludics mag process-suggestions <task-id>`

## Arguments

- `$ARGUMENTS`: `<task-id>` -- the completed task whose retrospective to process

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Process

1. Read the request ID:
   ```bash
   LUDICS_REQUEST_ID=$(cat "$LUDICS_STATE_PATH/mag/current-request-id" 2>/dev/null || echo "unknown")
   ```

2. Read retrospective file:
   ```bash
   cat "$LUDICS_STATE_PATH/retrospectives/$ARGUMENTS.json"
   ```
   If file is missing, write an error result and stop.

3. Parse JSON and extract `suggestRefactorSummary` (string or null) and
   `workflowFeedback` (object keyed by agent name, values are strings).

4. If both fields are empty/null, write an empty result and stop.

5. Read the source task file to recover project name:
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/$ARGUMENTS.md"
   ```
   Extract the `project` field from frontmatter.

6. **Normalize and dedupe**: Split unstructured text into individual suggestion
   items. The `suggestRefactorSummary` may be a single text blob -- split by
   logical suggestion boundaries (numbered items, bullet points, paragraph
   breaks). Each `workflowFeedback` entry may also contain multiple
   suggestions -- split those too. Merge near-duplicate items.

7. **Idempotency guard**: Before creating any tasks, scan existing task files
   for follow-ups already created from this source task:
   ```bash
   grep -l "relates_to:.*$ARGUMENTS" "$LUDICS_STATE_PATH/tasks/"*.md 2>/dev/null || true
   ```
   For each existing follow-up, read its title. Skip any new suggestion that
   substantially overlaps with an existing follow-up title or theme.

8. For each distinct suggestion, classify:
   - **Substantive** -- create a task
   - **Nitpicky** -- skip with logged reasoning

   **Group small related suggestions into a single task.** When multiple
   substantive suggestions touch neighboring code (same file, same function,
   or tightly coupled modules), combine them into one follow-up task rather
   than creating separate tasks for each. The task title should reflect the
   combined scope, and the context should list all constituent suggestions.
   This avoids task sprawl from retrospectives — a single coherent cleanup
   task is better than three tiny ones.

9. For substantive suggestions (or groups of related suggestions):
   a. Run: `ludics tasks create "<title>" <project> C`
   b. Check stdout:
      - If `"Task already exists"`: read the existing task file. If its
        `relates_to` includes the current source task-id OR the title clearly
        matches this suggestion, skip (true duplicate). Otherwise the collision
        is accidental -- append the source task-id suffix to the title
        (e.g., "Refactor X (from task-abc123)") and retry creation.
      - If `"ID: task-..."`: parse the new task ID.
   c. Rewrite the new task file to set:
      - `status: needs-confirmation` (replace `status: ready`)
      - `effort: small` (replace `effort: medium`)
      - `relates_to: [$ARGUMENTS]` (replace `relates_to: []`)
      - Replace Context section body with:
        "Auto-generated from retrospective of `<source-task-id>`.
         Original suggestion: <brief summary>"

10. Write result JSON:
    ```bash
    cat > "$LUDICS_RESULTS_DIR/$LUDICS_REQUEST_ID.json" << 'RESULT_EOF'
    {
      "id": "<request-id>",
      "status": "completed",
      "timestamp": "<ISO timestamp>",
      "created": <count>,
      "skipped": <count>,
      "tasks": ["task-xxx", ...],
      "skipReasons": [{"suggestion": "...", "reason": "..."}]
    }
    RESULT_EOF
    ```

## Judgment Criteria

**Create task (substantive)**:
- Architectural refactoring that affects multiple modules
- Missing error handling or edge cases
- Performance improvements with measurable impact
- API design improvements that affect downstream consumers
- Missing test coverage for important code paths
- Security or correctness concerns
- Workflow improvements that reduce friction across multiple tasks

**Skip (nitpicky)**:
- Variable/function renaming for style preference
- Comment rewording or documentation formatting
- Import reordering or minor code organization
- Minor formatting changes (whitespace, bracket style)
- Suggestions already covered by existing tasks (check relates_to overlap)
- Cosmetic UI tweaks with no functional impact

## Error Handling

- Missing retrospective file: write `{"status": "error", "message": "retrospective not found"}`
- Empty suggestions: write `{"status": "empty"}`
- Partial failure during batch creation: report partial success in result JSON
  with the tasks created so far and error details

## Output

Report a summary after processing:

```
STATUS: completed | empty | error
CREATED: <count>
SKIPPED: <count>
TASKS: [list of created task IDs]
```
