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

3. Parse JSON and extract:
   - `suggestRefactorSummary` (string or null)
   - `workflowFeedback` (object keyed by agent name, values are strings)
   - `reviews` (array of `{ round, type, reviewer, verdict, content }`)

   For each review `type` ("review", "plan-review"), keep only the
   highest-round entry (earlier rounds are superseded by later ones
   regardless of verdict). Then discard any entry whose verdict is not
   `request_changes`. This ordering matters: a round 2 `approve` supersedes
   a round 1 `request_changes`, meaning the issue was resolved and should
   NOT generate a follow-up task.

4. If all three sources are empty/null — `suggestRefactorSummary` is null,
   `workflowFeedback` has no entries, AND no `request_changes` reviews remain
   after filtering — write an empty result and stop.

5. Read the source task file to recover project name:
   ```bash
   cat "$LUDICS_STATE_PATH/tasks/$ARGUMENTS.md"
   ```
   Extract the `project` field from frontmatter.

6. **Normalize and dedupe**: Split unstructured text into individual suggestion
   items. The `suggestRefactorSummary` may be a single text blob -- split by
   logical suggestion boundaries (numbered items, bullet points, paragraph
   breaks). Each `workflowFeedback` entry may also contain multiple
   suggestions -- split those too.

   For each filtered `request_changes` review: strip the leading verdict
   keyword line from `content`. The verdict line may appear in several formats
   — plain `REQUEST_CHANGES`, bolded `**Verdict**: REQUEST_CHANGES`, or
   similar variants. Strip any line whose uppercased text contains
   `REQUEST_CHANGES` and appears before the first actionable item. Split the
   remaining text by numbered items or bullet points into individual
   suggestion items. Tag each item with its source review metadata (round,
   reviewer, type).

   Merge near-duplicate items across all three sources. Reviews may overlap
   with `suggestRefactorSummary` content since both can originate from the
   same reviewer agent -- dedupe these.

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
      - Replace Context section body with context appropriate to the source:
        - **From review artifact**: "Auto-generated from review round N by
          <reviewer> (REQUEST_CHANGES) of `<source-task-id>`. Issue identified:
          <brief summary>"
        - **From other sources**: "Auto-generated from retrospective of
          `<source-task-id>`. Original suggestion: <brief summary>"

10. **PR comment confirmation**: If any tasks were created, read the `prUrl`
    field from the retrospective JSON (parsed in step 3). If `prUrl` is
    non-null and non-empty, post a comment on the PR confirming the created
    follow-up tasks:
    ```bash
    gh pr comment "$PR_URL" --body "$(cat <<EOF
    **Follow-up tasks created from retrospective:**

    $(for task_id in "${CREATED_TASKS[@]}"; do
      title=$(grep '^title:' "$LUDICS_STATE_PATH/tasks/$task_id.md" | sed 's/^title: //')
      echo "- \`$task_id\`: $title (needs-confirmation)"
    done)

    _Auto-generated by process-suggestions._
    EOF
    )"
    ```
    If `prUrl` is null or the `gh pr comment` command fails, log a warning
    but do not fail the overall skill — the tasks are already created.

11. Write result JSON:
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
- Items from `REQUEST_CHANGES` reviews: these are high-signal because the
  reviewer explicitly flagged the issue and the coder did not address it
  before task completion. Lean toward "substantive" classification unless the
  issue is purely stylistic (variable naming, formatting).

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
