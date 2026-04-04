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
- **A** (Task Resolution): read task file, extract title/project/slot
- **B** (Project Path): resolve project checkout path from config
- **C** (Context Brief): compose 3-10 line brief from conversation history
- **D** (Worker Delegation): invoke worker in forked context
- **E** (Result JSON): write result with request ID
- **F** (Error Handling): standard error patterns

Worker: `/ludics-elaborate-worker <task_id> <project_path> <context_brief>`

## Skill-Specific: Status Routing

Extract the JSON block from the worker's response (the last fenced ` ```json ` block).
Parse the JSON for `status`, `questions`, and `summary`.

### Expected Worker Fields

1. `status` — primary routing. Absent: error (malformed response).
2. `questions` — questions notification. Absent: treat as `"none"`, skip notification.
3. `summary` — result context. Absent: use empty string.
4. `merge_target` — result JSON (merged path). Only expected when `status = "merged"`.
5. `elaborated_date` — already-elaborated path. Only expected when `status = "already-elaborated"`.
6. `title` — notification title. Absent: fall back to task_id.
7. `task_id` — not consumed by orchestrator.

- **status: completed** — proceed to notifications
- **status: merged** — write result JSON noting the merge, stop
- **status: already-elaborated** — ask if re-elaboration is wanted, or skip
- **status: error** — write result JSON with `"status": "error"`, stop

## Skill-Specific: Questions Notification

If `questions` is not `"none"` and is non-empty:

1. **Add `has_questions: true`** to the task file frontmatter (this blocks proposal generation
   until the user answers the questions and removes the field).

2. Send as notification text:
   - Format each element as a numbered list (e.g., `1. <q1>\n2. <q2>`)

```bash
ludics notify outgoing "<formatted questions>"
```

Use title: "Elaboration questions — <task_id>: <title>"

If `questions` is `"none"` or an empty array/string, do NOT add `has_questions` to frontmatter.

## Skill-Specific Result Fields

```json
{
  "task_id": "<task_id>"
}
```

## Delegation Strategy

- **Worker** (`/ludics-elaborate-worker`): Duplicate checking, context gathering,
  codebase exploration, spec writing, task file update — runs in isolated context
- **Orchestrator** (this skill): Task file read, decision routing, notifications,
  result JSON — runs inline in Mag's context
