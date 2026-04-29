---
name: ludics-elaborate
description: Elaborate a task into a detailed specification
queue-action: elaborate
queue-args: [task]
---

# /ludics-elaborate - Task Elaboration (Orchestrator)

Thin orchestrator that reads the task, delegates context gathering and spec
writing to an isolated worker, then handles notifications and result reporting.

## Trigger

This skill is invoked:
- When the user runs `ludics mag elaborate <task_id>`
- Before assigning a task to a slot
- For freshly generated tasks from the `ludics tasks sync` automation

## Arguments

- `$ARGUMENTS`: `<task_id>` — Task identifier (e.g., `task-042`)

## Inputs

- `$LUDICS_STATE_PATH`: Path to the harness directory (environment variable)
- **Request ID**: Read from file `$LUDICS_STATE_PATH/mag/current-request-id`

## Common Steps

Follow [orchestrator-conventions.md](orchestrator-conventions.md):
- **A** (Task Resolution): read task file, extract title/project/slot.
- **B** (Project Path): resolve the project checkout from config.
- **C** (Context Brief): compose a 3-10 line brief from conversation history.
- **D** (Worker Delegation): invoke the worker in forked context.
- **E** (Result JSON): write the result with the request ID.
- **F** (Error Handling): standard patterns.

### Container short-circuit (before Step D)

If the task's frontmatter has `leaf: false`, the work has already been split
into subtasks and elaborating the parent is a no-op. After Step A, before
worker delegation:

1. Use the `Edit` tool to append a single line to the task's `## Notes`
   section: `Skipped: container task — work split into children`.
   The shared `appendToSection` helper dedupes (skips if the exact line is
   already present), so repeated stale queue items do not stack.
2. Write a result JSON with `"status": "skipped-container"` and the parent's
   id, then exit. **Do not invoke the worker.**
3. The queue-pop layer drops this request rather than re-queueing.

Worker: `/ludics-elaborate-worker <task_id> <project_path> <context_brief>`

## Status routing

Extract the final ` ```json ` block from the worker's response. Fields:

| Field | Used for | Missing-field fallback |
|---|---|---|
| `status` | primary routing | error (malformed response) |
| `questions` | questions notification | treat as `"none"`, skip |
| `summary` | result context | empty string |
| `merge_target` | result JSON | only when `status = "merged"` |
| `elaborated_date` | already-elaborated path | only when `status = "already-elaborated"` |
| `title` | notification title | fall back to task_id |
| `task_id` | — | not consumed |

Routing by status:
- **completed** — proceed to notifications.
- **merged** — write result JSON noting the merge and stop.
- **already-elaborated** — ask whether re-elaboration is wanted, or skip.
- **error** — write result JSON with `"status": "error"` and stop.

## Questions notification

If `questions` is non-empty (and not `"none"`):

1. Add `has_questions: true` to the task frontmatter — this blocks proposal
   generation until the user answers and removes the field.
2. Send the questions as a numbered list:

   ```bash
   ludics notify outgoing "<formatted questions>"
   ```

   Use title: `"Elaboration questions — <task_id>: <title>"`.

When `questions` is `"none"` or empty, don't add `has_questions`.

## Result fields

```json
{
  "task_id": "<task_id>"
}
```

## Delegation strategy

- Worker (`/ludics-elaborate-worker`) runs in isolated context: duplicate
  checking, context gathering, codebase exploration, spec writing, task file
  update.
- Orchestrator (this skill) runs inline in Mag: task read, decision routing,
  notifications, result JSON.
